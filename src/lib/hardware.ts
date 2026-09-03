import os from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execCapture } from "./exec";

export interface HardwareProfile {
  cpuCores: number;
  totalMemMB: number;
  freeMemMB: number;
  diskFreeGB: number;
  tier: "micro" | "small" | "medium" | "large" | "xlarge";
}

// Phân cấp phần cứng theo RAM — dùng để chọn bộ tham số tối ưu cho
// nginx/MariaDB/Redis. Ranh giới lấy theo các mốc VPS phổ biến (1/2/4/8/16GB).
function tierFor(totalMemMB: number): HardwareProfile["tier"] {
  if (totalMemMB <= 1536) return "micro"; // ~1GB
  if (totalMemMB <= 3072) return "small"; // ~2GB
  if (totalMemMB <= 6144) return "medium"; // ~4GB
  if (totalMemMB <= 12288) return "large"; // ~8GB
  return "xlarge"; // >=16GB
}

export function detectHardware(): HardwareProfile {
  const cpuCores = os.cpus().length || 1;
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMB = Math.round(os.freemem() / 1024 / 1024);

  let diskFreeGB = 0;
  const df = execCapture("df", ["-BG", "--output=avail", "/"]);
  if (df.code === 0) {
    const lines = df.stdout.trim().split("\n");
    const last = lines[lines.length - 1]?.trim().replace("G", "");
    diskFreeGB = last ? parseInt(last, 10) || 0 : 0;
  }

  return {
    cpuCores,
    totalMemMB,
    freeMemMB,
    diskFreeGB,
    tier: tierFor(totalMemMB),
  };
}

export function formatHardware(h: HardwareProfile): string {
  return [
    `CPU        : ${h.cpuCores} lõi`,
    `RAM tổng   : ${(h.totalMemMB / 1024).toFixed(1)} GB (còn trống ~${(h.freeMemMB / 1024).toFixed(1)} GB)`,
    `Ổ đĩa trống: ${h.diskFreeGB} GB`,
    `Phân hạng  : ${h.tier}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Kiểm soát tài nguyên (CPUWeight / IOWeight / MemoryHigh) có THẬT SỰ hiệu lực?
//
// Đây là loại tính năng dễ nói dối nhất: systemd nhận directive, `systemctl
// show` in ra đúng giá trị, nhưng kernel không làm gì cả. Không có lỗi, không
// có cảnh báo — chỉ là ưu tiên bạn nghĩ mình đã đặt thì không tồn tại. Nên napp
// DÒ và NÓI THẲNG thay vì in một con số cho đẹp.
// ---------------------------------------------------------------------------
export interface ResourceControlSupport {
  // cgroup v2 (unified). Ubuntu 22.04+ mặc định v2; 20.04 là hybrid/v1, ở đó
  // systemd tự dịch CPUWeight -> CPUShares nên vẫn có tác dụng, chỉ là thang
  // chia khác. MemoryHigh thì CHỈ có ở v2.
  cgroupV2: boolean;
  // IOWeight chỉ hiệu lực với I/O scheduler 'bfq'. VPS NVMe thường dùng 'none'
  // hoặc 'mq-deadline' -> directive vô hiệu hoàn toàn.
  ioWeightEffective: boolean;
  ioSchedulers: string[]; // scheduler đang chọn của từng block device thật
}

/** Scheduler đang được CHỌN (nằm trong ngoặc vuông) của một block device. */
function selectedScheduler(dev: string): string | undefined {
  const path = `/sys/block/${dev}/queue/scheduler`;
  if (!existsSync(path)) return undefined;
  try {
    const m = /\[([a-z-]+)\]/.exec(readFileSync(path, "utf8"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

// Memo hoá: một lệnh `tune apply` gọi hàm này một lần cho MỖI unit, mà kết quả
// không đổi trong vòng đời tiến trình (đổi scheduler/cgroup phải reboot hoặc
// remount).
let resourceControlCache: ResourceControlSupport | undefined;

export function detectResourceControl(): ResourceControlSupport {
  if (resourceControlCache) return resourceControlCache;
  // 'cgroup2fs' = unified v2. Trên hybrid, /sys/fs/cgroup là tmpfs.
  const fsType = execCapture("stat", ["-fc", "%T", "/sys/fs/cgroup"]);
  const cgroupV2 = fsType.code === 0 && fsType.stdout.trim() === "cgroup2fs";

  const schedulers: string[] = [];
  try {
    for (const dev of readdirSync("/sys/block")) {
      // loop/ram/zram không phải đĩa thật — đưa vào chỉ làm nhiễu kết luận.
      if (/^(loop|ram|zram|sr)\d*$/.test(dev)) continue;
      const sched = selectedScheduler(dev);
      if (sched) schedulers.push(sched);
    }
  } catch {
    // /sys/block không đọc được (container tối giản) -> coi như không biết.
  }

  resourceControlCache = {
    cgroupV2,
    ioWeightEffective: schedulers.includes("bfq"),
    ioSchedulers: [...new Set(schedulers)],
  };
  return resourceControlCache;
}

/** Dòng mô tả cho `tune show` / `tune apply` — nói rõ cái gì có tác dụng thật. */
export function formatResourceControl(rc: ResourceControlSupport): string[] {
  const out: string[] = [];
  out.push(
    rc.cgroupV2
      ? "  CPUWeight/MemoryHigh : CÓ hiệu lực (cgroup v2)"
      : "  CPUWeight            : có hiệu lực qua CPUShares (cgroup v1 — systemd tự quy đổi)\n" +
        "  MemoryHigh           : KHÔNG có (chỉ tồn tại ở cgroup v2) — nâng lên Ubuntu 22.04+ để dùng"
  );
  if (rc.ioWeightEffective) {
    out.push("  IOWeight             : CÓ hiệu lực (I/O scheduler 'bfq')");
  } else {
    const list = rc.ioSchedulers.length > 0 ? rc.ioSchedulers.join(", ") : "không dò được";
    out.push(
      `  IOWeight             : KHÔNG có tác dụng — I/O scheduler hiện tại: ${list} (IOWeight cần 'bfq').\n` +
        `                         Directive vẫn được ghi (vô hại) để có sẵn nếu bạn đổi scheduler sang bfq.`
    );
  }
  return out;
}

import os from "node:os";
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

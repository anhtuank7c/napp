import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execCapture, writeFile, ensureDir } from "./exec";
import { loadState, serviceNameFor, svcSystemdName, NAPP_ROOT } from "./state";
import { unitWorkDir } from "../templates/systemd";

// ---------------------------------------------------------------------------
// Phát hiện rò rỉ bộ nhớ TRƯỚC khi app chết, không cần sửa một dòng code nào.
//
// Vì sao cần: unit của napp đều có 'Restart=always'. App rò rỉ sẽ chạm trần
// heap, CHẾT, rồi được systemd LẶNG LẼ khởi động lại — có thể lặp đi lặp lại
// nhiều ngày. Không ai biết cho tới khi nó tệ đến mức nhìn thấy được. Chính
// systemd đã đếm sẵn số lần đó ('NRestarts'), chỉ là chưa ai đọc ra.
//
// Đo cái gì: 'anon' trong memory.stat của cgroup, KHÔNG phải memory.current.
// memory.current bao gồm cả page cache — thứ phình ra rồi co lại theo I/O của
// máy, hoàn toàn không liên quan tới rò rỉ, và đủ nhiễu để dìm chết tín hiệu
// thật. 'anon' là bộ nhớ ẩn danh: heap, stack, mảng — đúng thứ rò rỉ làm phình.
// ---------------------------------------------------------------------------

export const MEMWATCH_LOG = `${NAPP_ROOT}/memwatch.jsonl`;
export const HEAPSNAP_DIR = "/var/lib/napp/heapsnapshots";
export const MEMWATCH_TIMER_NAME = "napp-memwatch";
// Giữ lại bấy nhiêu mẫu gần nhất. 3 đơn vị x 15 phút/mẫu ~ 288 mẫu/ngày -> đủ
// khoảng 70 ngày. Tự cắt bớt để KHÔNG phụ thuộc logrotate: file nằm ở /etc/napp,
// nơi không có cấu hình xoay vòng nào, và một file log tự phình vô hạn trên VPS
// nhỏ là cách tự tạo ra đúng sự cố mà công cụ này sinh ra để ngăn.
const MAX_SAMPLES = 20000;

export interface UnitRef {
  unit: string; // tên systemd, không có '.service'
  id: string; // domain (web) hoặc name (service)
  kind: "web" | "service";
}

/** Mọi đơn vị node napp đang quản lý. */
export function allUnits(): UnitRef[] {
  const s = loadState();
  return [
    ...Object.keys(s.apps).map((d) => ({ unit: serviceNameFor(d), id: d, kind: "web" as const })),
    ...Object.keys(s.services).map((n) => ({ unit: svcSystemdName(n), id: n, kind: "service" as const })),
  ];
}

export interface UnitMemory extends UnitRef {
  active: boolean;
  mainPid?: number;
  /** Bộ nhớ ẩn danh (heap/stack) — tín hiệu rò rỉ THẬT. */
  anonBytes?: number;
  /** Đỉnh kể từ lúc khởi động (cgroup v2, kernel mới). */
  peakBytes?: number;
  /** Số lần bị throttle vì vượt MemoryHigh (chỉ background service). */
  highEvents?: number;
  memoryHighBytes?: number;
  /** Số lần systemd đã âm thầm khởi động lại — dấu hiệu rõ nhất của rò rỉ. */
  restarts: number;
  /** Kết quả lần dừng gần nhất: 'oom-kill' là bằng chứng trực tiếp. */
  lastResult?: string;
}

function showProps(unit: string, props: string[]): Record<string, string> {
  const res = execCapture("systemctl", ["show", ...props.flatMap((p) => ["-p", p]), `${unit}.service`]);
  const out: Record<string, string> = {};
  if (res.code !== 0) return out;
  for (const line of res.stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Một trường trong file kiểu 'key value' của cgroup (memory.stat, memory.events). */
function cgroupField(path: string, key: string): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const [k, v] = line.split(/\s+/);
      if (k === key) return parseInt(v ?? "", 10);
    }
  } catch {
    /* không đọc được -> coi như không có */
  }
  return undefined;
}

function cgroupNumber(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "max") return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** RSS từ /proc — đường lui khi không có cgroup v2 (Ubuntu 20.04). */
function procRssBytes(pid: number): number | undefined {
  const p = `/proc/${pid}/status`;
  if (!existsSync(p)) return undefined;
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(p, "utf8"));
  return m?.[1] ? parseInt(m[1], 10) * 1024 : undefined;
}

export function readUnitMemory(ref: UnitRef): UnitMemory {
  const props = showProps(ref.unit, ["ControlGroup", "MainPID", "NRestarts", "ActiveState", "MemoryHigh", "Result"]);
  const mainPid = parseInt(props.MainPID ?? "0", 10) || undefined;
  const cg = props.ControlGroup ? `/sys/fs/cgroup${props.ControlGroup}` : undefined;

  const anonBytes = cg ? cgroupField(`${cg}/memory.stat`, "anon") : undefined;
  const memoryHighBytes = props.MemoryHigh && props.MemoryHigh !== "infinity" ? parseInt(props.MemoryHigh, 10) : undefined;

  return {
    ...ref,
    active: props.ActiveState === "active",
    mainPid,
    // Ưu tiên 'anon' của cgroup; không có thì lùi về VmRSS (kém chính xác hơn
    // vì gồm cả trang file được chia sẻ, nhưng vẫn theo dõi được xu hướng).
    anonBytes: anonBytes ?? (mainPid ? procRssBytes(mainPid) : undefined),
    peakBytes: cg ? cgroupNumber(`${cg}/memory.peak`) : undefined,
    highEvents: cg ? cgroupField(`${cg}/memory.events`, "high") : undefined,
    memoryHighBytes,
    restarts: parseInt(props.NRestarts ?? "0", 10) || 0,
    lastResult: props.Result && props.Result !== "success" ? props.Result : undefined,
  };
}

// --- lưu mẫu ---------------------------------------------------------------

export interface Sample {
  t: number; // unix seconds
  u: string; // unit
  a: number; // anon bytes
  r: number; // NRestarts tại thời điểm lấy mẫu
}

export function readSamples(): Sample[] {
  if (!existsSync(MEMWATCH_LOG)) return [];
  const out: Sample[] = [];
  for (const line of readFileSync(MEMWATCH_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Sample;
      if (typeof s.t === "number" && typeof s.a === "number") out.push(s);
    } catch {
      /* dòng hỏng (ghi dở lúc mất điện) -> bỏ qua, không làm hỏng cả file */
    }
  }
  return out;
}

/** Lấy một mẫu cho MỌI đơn vị đang chạy và ghi vào log. Trả về số mẫu đã ghi. */
export function takeSample(): number {
  const now = Math.floor(Date.now() / 1000);
  const fresh: Sample[] = [];
  for (const ref of allUnits()) {
    const m = readUnitMemory(ref);
    if (!m.active || m.anonBytes === undefined) continue; // đơn vị đang dừng -> không có gì để đo
    fresh.push({ t: now, u: m.unit, a: m.anonBytes, r: m.restarts });
  }
  if (fresh.length === 0) return 0;
  const kept = [...readSamples(), ...fresh].slice(-MAX_SAMPLES);
  ensureDir(NAPP_ROOT, 0o750);
  writeFile(MEMWATCH_LOG, kept.map((s) => JSON.stringify(s)).join("\n") + "\n", 0o640);
  return fresh.length;
}

// --- phân tích xu hướng ----------------------------------------------------

export type Verdict = "insufficient" | "ok" | "watch" | "leak";

export interface Trend {
  unit: string;
  samples: number;
  spanHours: number;
  baselineMB: number;
  currentMB: number;
  growthMB: number;
  growthPct: number;
  mbPerDay: number;
  verdict: Verdict;
  /** Số lần restart trong toàn bộ log — không chỉ đoạn đang xét. */
  restartsSeen: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Xu hướng bộ nhớ của MỘT đơn vị.
 *
 * HAI ĐIỀU QUYẾT ĐỊNH ĐỘ TIN CẬY, và bỏ qua cái nào cũng biến công cụ này thành
 * thứ kêu oan liên tục rồi bị người dùng học cách phớt lờ:
 *
 * 1. CHỈ XÉT ĐOẠN TỪ LẦN RESTART GẦN NHẤT. Mỗi lần tiến trình khởi động lại là
 *    bộ nhớ về mo — ghép hai bên của một lần restart vào cùng một đường xu hướng
 *    thì được một cái dốc âm vô nghĩa, che mất đúng cái rò rỉ đã gây ra restart.
 *
 * 2. SO TRUNG VỊ CỦA HAI PHẦN TƯ ĐẦU/CUỐI, không so mẫu đầu với mẫu cuối. Một
 *    mẫu đơn lẻ rơi đúng lúc GC vừa chạy (hoặc chưa chạy) lệch tới hàng chục MB.
 *
 * Ngoài ra RSS/anon của Node LUÔN tăng lúc đầu rồi đi ngang: V8 không trả bộ nhớ
 * về hệ điều hành sớm. Nên ngưỡng phải tính theo % VÀ theo MB tuyệt đối, và cần
 * một khoảng thời gian đủ dài — dưới 6 giờ thì không kết luận gì cả.
 */
export function analyseTrend(samples: Sample[], unit: string): Trend {
  const mine = samples.filter((s) => s.u === unit).sort((a, b) => a.t - b.t);
  const restartsSeen = mine.length > 1 ? Math.max(0, (mine[mine.length - 1]?.r ?? 0) - (mine[0]?.r ?? 0)) : 0;

  // Đoạn hiện tại = dãy mẫu cuối cùng có cùng số lần restart.
  const lastR = mine[mine.length - 1]?.r;
  let start = mine.length;
  while (start > 0 && mine[start - 1]?.r === lastR) start--;
  const seg = mine.slice(start);

  const empty: Trend = {
    unit, samples: seg.length, spanHours: 0, baselineMB: 0, currentMB: 0,
    growthMB: 0, growthPct: 0, mbPerDay: 0, verdict: "insufficient", restartsSeen,
  };
  if (seg.length < 8) return empty;

  const spanHours = ((seg[seg.length - 1]!.t - seg[0]!.t) / 3600);
  if (spanHours < 6) return { ...empty, spanHours };

  const q = Math.max(2, Math.floor(seg.length / 4));
  const baseline = median(seg.slice(0, q).map((s) => s.a)) / 1048576;
  const current = median(seg.slice(-q).map((s) => s.a)) / 1048576;
  const growthMB = current - baseline;
  const growthPct = baseline > 0 ? (growthMB / baseline) * 100 : 0;

  // Tốc độ tính trên khoảng cách giữa TÂM hai phần tư, KHÔNG phải toàn bộ span.
  // growthMB là hiệu hai trung vị, mà hai trung vị đó nằm ở giữa phần tư đầu và
  // phần tư cuối — cách nhau ngắn hơn cả đoạn. Chia cho span là báo tốc độ THẤP
  // hơn thực tế (đo được: 291 MB/ngày trong khi thật là 384). Con số này chính
  // là thứ người dùng dùng để ước lượng "còn bao lâu nữa thì chạm trần heap",
  // nên thấp hơn thực tế là nguy hiểm chứ không phải thận trọng.
  const midFirst = seg[Math.floor(q / 2)]!.t;
  const midLast = seg[seg.length - 1 - Math.floor(q / 2)]!.t;
  const rateHours = (midLast - midFirst) / 3600;
  const mbPerDay = rateHours > 0 ? (growthMB / rateHours) * 24 : 0;

  // Ngưỡng CỐ Ý thận trọng — xem chú thích trên về vì sao.
  let verdict: Verdict = "ok";
  if (growthMB >= 64 && growthPct >= 50) verdict = "leak";
  else if (growthMB >= 32 && growthPct >= 20) verdict = "watch";

  return {
    unit, samples: seg.length, spanHours: Math.round(spanHours * 10) / 10,
    baselineMB: Math.round(baseline), currentMB: Math.round(current),
    growthMB: Math.round(growthMB), growthPct: Math.round(growthPct),
    mbPerDay: Math.round(mbPerDay), verdict, restartsSeen,
  };
}

/** File .heapsnapshot còn sót trong thư mục app — bằng chứng app ĐÃ chạm trần heap. */
export function strayHeapSnapshots(): { id: string; dir: string; files: { name: string; mb: number }[] }[] {
  const s = loadState();
  const dirs: { id: string; dir: string }[] = [
    ...Object.values(s.apps).map((a) => ({ id: a.domain, dir: unitWorkDir(a.webRoot, a.appDir) })),
    ...Object.values(s.services).map((v) => ({ id: v.name, dir: unitWorkDir(v.workDir, v.appDir) })),
  ];
  const out: { id: string; dir: string; files: { name: string; mb: number }[] }[] = [];
  for (const d of dirs) {
    if (!existsSync(d.dir)) continue;
    try {
      const files = readdirSync(d.dir)
        .filter((f) => f.endsWith(".heapsnapshot"))
        .map((f) => ({ name: f, mb: Math.round(statSync(`${d.dir}/${f}`).size / 1048576) }));
      if (files.length > 0) out.push({ ...d, files });
    } catch {
      /* không đọc được thư mục -> bỏ qua */
    }
  }
  return out;
}

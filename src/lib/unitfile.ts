import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "./exec";

// ---------------------------------------------------------------------------
// Ghi unit systemd mà KHÔNG xoá mất phần người dùng sửa tay.
//
// Trước đây mọi đường dẫn đụng tới unit đều render lại TOÀN BỘ file từ template
// rồi ghi đè. Ai sửa tay ExecStart (thêm cờ runtime), StandardOutput/StandardError
// (đẩy log sang journal hoặc file khác), hay User/Group (chạy bằng danh tính
// khác) sẽ mất hết sau lần `napp tune apply` kế tiếp — và app chết ngay lúc
// restart, đúng lúc không ai ngờ tới.
//
// Cơ chế ở đây gồm hai lớp:
//
//   1. FINGERPRINT — mỗi unit napp ghi ra mang một dòng
//      '# napp-fingerprint: <sha256>' tính trên phần còn lại của file. Lần sau
//      napp so lại: khớp = file còn nguyên bản napp (ghi đè thoải mái), lệch
//      hoặc không có = có người đã sửa (phải giữ lại).
//
//   2. DANH SÁCH GIỮ NGUYÊN — khi phát hiện file đã sửa, napp so từng directive
//      trong PRESERVABLE_DIRECTIVES; directive nào người dùng đổi thì lấy bản
//      của họ và ghi tên nó vào dòng '# napp-preserve: ...'. Dòng này tồn tại
//      để lần ghi SAU vẫn biết directive đó thuộc về người dùng — nếu chỉ dựa
//      vào fingerprint thì ngay sau lần merge đầu tiên file lại "khớp" và lần
//      thứ hai sẽ ghi đè mất. Người dùng cũng có thể tự thêm dòng này để khoá
//      trước một directive.
// ---------------------------------------------------------------------------

const FINGERPRINT_KEY = "# napp-fingerprint:";
const PRESERVE_KEY = "# napp-preserve:";
// Dòng chú thích đi kèm PRESERVE_KEY. Có tiền tố riêng để lần ghi sau nhận ra và
// gỡ đi — nếu không, mỗi lần stamp lại nối thêm một bản sao.
const PRESERVE_NOTE_KEY = "#   ^ ";

// Những directive napp sinh ra nhưng người dùng CÓ LÝ DO CHÍNH ĐÁNG để sửa tay.
// Chỉ các tên trong danh sách này mới được giữ lại — phần hardening
// (ProtectSystem, NoNewPrivileges, ReadWritePaths...) vẫn do napp làm chủ để
// bản vá bảo mật còn đường lan tới unit cũ.
export const PRESERVABLE_DIRECTIVES = [
  "ExecStart",
  "ExecStartPre",
  "ExecStartPost",
  "ExecReload",
  "ExecStop",
  "ExecStopPost",
  "StandardOutput",
  "StandardError",
  "StandardInput",
  "SyslogIdentifier",
  "User",
  "Group",
  "UMask",
  "WorkingDirectory",
  "Restart",
  "RestartSec",
  "TimeoutStartSec",
  "TimeoutStopSec",
  "LimitNOFILE",
  "Nice",
  "OOMScoreAdjust",
  "MemoryMax",
  "MemoryHigh",
  "CPUQuota",
] as const;

export type UnitStatus = "missing" | "managed" | "customized" | "unknown";

export interface UnitWriteResult {
  action: "created" | "rewritten" | "merged" | "unchanged";
  status: UnitStatus;
  preserved: string[]; // directive lấy theo bản của người dùng
  overridden: string[]; // directive napp buộc phải đặt lại dù người dùng đã sửa
}

// --- đọc / phân tích -------------------------------------------------------

/** Bỏ dòng fingerprint đi rồi băm phần còn lại — đổi bất kỳ dòng nào cũng lệch. */
function fingerprintOf(text: string): string {
  const body = text
    .split("\n")
    .filter((l) => !l.startsWith(FINGERPRINT_KEY))
    .join("\n");
  return createHash("sha256").update(body).digest("hex");
}

function recordedFingerprint(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(FINGERPRINT_KEY));
  return line?.slice(FINGERPRINT_KEY.length).trim() || undefined;
}

/** Tên directive người dùng (hoặc lần merge trước) đã khoá lại. */
export function recordedPreserves(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(PRESERVE_KEY)) continue;
    out.push(...line.slice(PRESERVE_KEY.length).trim().split(/[\s,]+/).filter(Boolean));
  }
  return [...new Set(out)];
}

export function unitStatus(path: string): UnitStatus {
  if (!existsSync(path)) return "missing";
  const text = readFileSync(path, "utf8");
  const recorded = recordedFingerprint(text);
  if (!recorded) return "unknown"; // unit của napp bản cũ, hoặc do người khác tạo
  return recorded === fingerprintOf(text) ? "managed" : "customized";
}

// Một directive có thể trải nhiều dòng nếu dòng trước kết thúc bằng '\'
// (systemd nối lại). Gom cả cụm để copy nguyên vẹn, không cắt giữa chừng.
interface DirectiveBlock {
  name: string;
  start: number; // chỉ số dòng bắt đầu
  lines: string[]; // toàn bộ dòng của directive, kể cả dòng nối tiếp
}

const SERVICE_SECTION = "[Service]";

/**
 * Quét các directive trong khối [Service]. Chỉ khối này — mọi directive được
 * phép giữ nguyên đều nằm ở đó, và giới hạn phạm vi tránh nhầm với [Unit]/[Install].
 */
function scanServiceDirectives(lines: string[]): DirectiveBlock[] {
  const blocks: DirectiveBlock[] = [];
  let inService = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inService = trimmed === SERVICE_SECTION;
      continue;
    }
    if (!inService) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*)=/.exec(trimmed);
    if (!m?.[1]) continue;
    const block: DirectiveBlock = { name: m[1], start: i, lines: [line] };
    while ((block.lines[block.lines.length - 1] ?? "").trimEnd().endsWith("\\") && i + 1 < lines.length) {
      i++;
      block.lines.push(lines[i] ?? "");
    }
    blocks.push(block);
  }
  return blocks;
}

/** Chỉ số dòng cuối của khối [Service] (dòng ngay trước section kế tiếp). */
function serviceSectionEnd(lines: string[]): number {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    if (t === SERVICE_SECTION) {
      start = i;
      continue;
    }
    if (start >= 0 && t.startsWith("[") && t.endsWith("]")) return i;
  }
  return start >= 0 ? lines.length : -1;
}

function blocksNamed(blocks: DirectiveBlock[], name: string): DirectiveBlock[] {
  return blocks.filter((b) => b.name === name);
}

function blockText(blocks: DirectiveBlock[]): string {
  return blocks.flatMap((b) => b.lines).join("\n");
}

// --- ghép bản người dùng vào bản render mới --------------------------------

/**
 * Thay TOÀN BỘ các dòng của directive `name` trong `lines` bằng `replacement`.
 * Giữ nguyên vị trí dòng đầu tiên để thứ tự directive không đảo lộn (systemd:
 * directive sau thắng directive trước — đảo thứ tự là đổi ngữ nghĩa).
 * Nếu bản render không có directive này, chèn vào cuối khối [Service].
 */
function replaceServiceDirective(lines: string[], name: string, replacement: string[]): string[] {
  const blocks = blocksNamed(scanServiceDirectives(lines), name);
  if (blocks.length === 0) {
    const end = serviceSectionEnd(lines);
    if (end < 0) return lines;
    return [...lines.slice(0, end), ...replacement, ...lines.slice(end)];
  }
  const out: string[] = [];
  const removed = new Set<number>();
  for (const b of blocks) for (let i = 0; i < b.lines.length; i++) removed.add(b.start + i);
  const firstStart = blocks[0]?.start ?? -1;
  for (let i = 0; i < lines.length; i++) {
    if (i === firstStart) out.push(...replacement);
    if (removed.has(i)) continue;
    out.push(lines[i] ?? "");
  }
  return out;
}

function stripMarkers(lines: string[]): string[] {
  return lines.filter((l) => !l.startsWith(FINGERPRINT_KEY) && !l.startsWith(PRESERVE_KEY) && !l.startsWith(PRESERVE_NOTE_KEY));
}

/**
 * Gắn dòng '# napp-preserve:' (nếu có) và dòng fingerprint vào ngay sau dòng
 * chú thích đầu tiên — nơi người đọc file nhìn thấy trước tiên.
 */
function stamp(text: string, preserved: string[]): string {
  const lines = stripMarkers(text.split("\n"));
  const markers: string[] = [];
  if (preserved.length > 0) {
    markers.push(`${PRESERVE_KEY} ${[...preserved].sort().join(" ")}`);
    markers.push(`${PRESERVE_NOTE_KEY}directive do BẠN làm chủ — napp sẽ không ghi đè. Xoá tên khỏi dòng trên để trả lại cho napp.`);
  }
  const at = lines[0]?.startsWith("#") ? 1 : 0;
  const withMarkers = [...lines.slice(0, at), ...markers, ...lines.slice(at)];
  const fp = fingerprintOf(withMarkers.join("\n"));
  return [...withMarkers.slice(0, at), `${FINGERPRINT_KEY} ${fp}`, ...withMarkers.slice(at)].join("\n");
}

export interface WriteManagedUnitOptions {
  // Directive napp CỐ Ý đặt lại lần này vì cấu hình trong registry đã đổi
  // (ví dụ `napp service set --run-as` đổi User/Group). Những tên này bỏ qua
  // cơ chế giữ nguyên, và bị gỡ khỏi danh sách '# napp-preserve:'.
  authoritative?: string[];
}

/**
 * Ghi unit từ bản render mới nhưng GIỮ LẠI directive người dùng đã sửa tay.
 * Trả về kết quả để caller in cho người dùng biết cái gì được giữ.
 */
export function writeManagedUnit(path: string, rendered: string, opts: WriteManagedUnitOptions = {}): UnitWriteResult {
  const authoritative = new Set(opts.authoritative ?? []);
  const status = unitStatus(path);

  if (status === "missing") {
    writeFile(path, stamp(rendered, []), 0o644);
    return { action: "created", status, preserved: [], overridden: [] };
  }

  const existing = readFileSync(path, "utf8");
  const existingLines = existing.split("\n");
  const existingBlocks = scanServiceDirectives(existingLines);
  const renderedLines = rendered.split("\n");
  const renderedBlocks = scanServiceDirectives(renderedLines);

  // Ứng viên giữ nguyên: tên đã ghi trong '# napp-preserve:' + (nếu file đã bị
  // sửa) directive nào trong danh sách cho phép mà giá trị lệch với bản render.
  const candidates = new Set(recordedPreserves(existing));
  if (status !== "managed") {
    for (const name of PRESERVABLE_DIRECTIVES) {
      const mine = blocksNamed(existingBlocks, name);
      // Không có trong file cũ = directive MỚI của template (ví dụ napp thêm
      // LimitNOFILE ở bản sau) -> lấy bản render, không coi là người dùng sửa.
      if (mine.length === 0) continue;
      if (blockText(mine) !== blockText(blocksNamed(renderedBlocks, name))) candidates.add(name);
    }
  }

  const preserved: string[] = [];
  const overridden: string[] = [];
  let out = renderedLines;
  for (const name of [...candidates].sort()) {
    const mine = blocksNamed(existingBlocks, name);
    if (mine.length === 0) continue; // người dùng đã xoá khỏi file -> hết gì để giữ
    if (authoritative.has(name)) {
      if (blockText(mine) !== blockText(blocksNamed(renderedBlocks, name))) overridden.push(name);
      continue;
    }
    out = replaceServiceDirective(out, name, mine.flatMap((b) => b.lines));
    preserved.push(name);
  }

  const text = stamp(out.join("\n"), preserved);
  if (text === existing) return { action: "unchanged", status, preserved, overridden };
  writeFile(path, text, 0o644);
  return { action: preserved.length > 0 ? "merged" : "rewritten", status, preserved, overridden };
}

// --- vá đúng MỘT giá trị: --max-old-space-size ------------------------------

const HEAP_FLAG = /--max-old-space-size=\d+/;

export interface HeapPatchResult {
  changed: boolean;
  previous?: number; // giá trị cũ, nếu file đã có cờ này
  note?: string; // điều caller nên cảnh báo người dùng
}

/**
 * Đổi DUY NHẤT số MB trong '--max-old-space-size' của dòng
 * 'Environment=NODE_OPTIONS=' đầu tiên trong [Service]. Mọi dòng khác — kể cả
 * các cờ NODE_OPTIONS khác trên chính dòng đó — giữ nguyên từng ký tự.
 *
 * Cân đối heap giữa các app là việc chạy NGẦM và chạy THƯỜNG XUYÊN (mỗi lần
 * tạo/xoá app, mỗi lần `napp tune apply`). Render lại cả file cho một con số là
 * cách chắc chắn nhất để một hôm nào đó thổi bay ExecStart người dùng đã sửa.
 */
export function patchUnitHeap(path: string, heapMB: number): HeapPatchResult {
  if (!existsSync(path)) return { changed: false, note: "unit không tồn tại" };
  const original = readFileSync(path, "utf8");

  // Người dùng đã khoá NODE_OPTIONS lại thì không đụng vào nữa.
  if (recordedPreserves(original).includes("Environment")) {
    return { changed: false, note: "Environment nằm trong '# napp-preserve:' — bỏ qua" };
  }

  const wasManaged = unitStatus(path) === "managed";
  const lines = original.split("\n");
  const nodeOptionLines = scanServiceDirectives(lines)
    .filter((b) => b.name === "Environment" && /^Environment="?NODE_OPTIONS=/.test((b.lines[0] ?? "").trim()))
    .map((b) => b.start);

  let next: string[];
  let previous: number | undefined;
  let note: string | undefined;

  if (nodeOptionLines.length === 0) {
    // Chưa có dòng nào: chèn vào đúng chỗ template vẫn đặt — TRƯỚC
    // EnvironmentFile, để .env của người dùng còn ghi đè được.
    const idx = lines.findIndex((l) => l.trim().startsWith("EnvironmentFile="));
    const at = idx >= 0 ? idx : serviceSectionEnd(lines);
    if (at < 0) return { changed: false, note: "không tìm thấy khối [Service]" };
    next = [...lines.slice(0, at), `Environment=NODE_OPTIONS=--max-old-space-size=${heapMB}`, ...lines.slice(at)];
  } else {
    // Vá dòng ĐẦU TIÊN — đó là chỗ napp đặt mặc định. Dòng NODE_OPTIONS người
    // dùng tự thêm sau nó vẫn thắng (systemd lấy directive cuối), tức lựa chọn
    // của họ không bị con số napp tính ra lật lại.
    const i = nodeOptionLines[0] ?? 0;
    const before = lines[i] ?? "";
    const m = HEAP_FLAG.exec(before);
    if (m) previous = parseInt(m[0].slice(m[0].indexOf("=") + 1), 10);
    const patched = m
      ? before.replace(HEAP_FLAG, `--max-old-space-size=${heapMB}`)
      : // Có NODE_OPTIONS nhưng chưa có cờ heap: nối thêm, giữ nguyên cờ cũ.
        before.replace(
          /^(\s*Environment=)("?)NODE_OPTIONS=(.*?)("?)\s*$/,
          (_s: string, head: string, q1: string, val: string, q2: string) =>
            `${head}${q1}NODE_OPTIONS=${val ? `${val} ` : ""}--max-old-space-size=${heapMB}${q2}`
        );
    if (nodeOptionLines.length > 1) {
      note = `unit có ${nodeOptionLines.length} dòng Environment=NODE_OPTIONS — chỉ vá dòng đầu, dòng sau của bạn vẫn là dòng có hiệu lực`;
    }
    next = [...lines];
    next[i] = patched;
  }

  const patchedText = next.join("\n");
  if (patchedText === original) return { changed: false, previous, note };
  // Chỉ đóng lại fingerprint khi file TRƯỚC ĐÓ còn nguyên bản napp. File đã bị
  // sửa tay phải tiếp tục bị coi là "đã sửa" ở những lần ghi sau.
  writeFile(path, wasManaged ? stamp(patchedText, recordedPreserves(original)) : patchedText, 0o644);
  return { changed: true, previous, note };
}

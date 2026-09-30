import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "./exec";

// Parse .env đơn giản (KEY=VALUE mỗi dòng, bỏ qua dòng trống/comment). Không
// xử lý multi-line values — đủ dùng cho mục đích cấu hình kết nối DB/Redis.
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function serializeEnv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => `${k}=${needsQuote(v) ? JSON.stringify(v) : v}`)
      .join("\n") + "\n"
  );
}

function needsQuote(v: string): boolean {
  return /[\s#"'$]/.test(v);
}

// Merge idempotent: đọc .env hiện có (nếu có), GHI ĐÈ các key được truyền
// vào, giữ nguyên các key khác. Dùng khi tạo app (--db/--redis) và khi
// 'napp app env set' cập nhật biến môi trường.
/** Xoá các key khỏi .env, giữ nguyên các key khác. Trả về các key thật sự đã có để xoá. */
export function removeEnvKeys(path: string, keys: string[], mode = 0o600): string[] {
  const current = parseEnvFile(path);
  const removed = keys.filter((k) => k in current);
  for (const k of removed) delete current[k];
  if (removed.length > 0) writeFile(path, serializeEnv(current), mode);
  return removed;
}

// Giá trị có vẻ là bí mật — che khi liệt kê (xem '... env list --reveal').
const SECRET_KEY = /PASS|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|^KEY$|DATABASE_URL|_URI$|_URL$|DSN/i;

/** In .env dạng KEY=VALUE, che giá trị bí mật trừ khi reveal. */
export function printEnvFile(path: string, reveal: boolean): void {
  const vars = parseEnvFile(path);
  const keys = Object.keys(vars).sort();
  if (keys.length === 0) {
    console.log(`  (trống — ${path})`);
    return;
  }
  for (const k of keys) {
    const v = vars[k]!;
    const masked = !reveal && SECRET_KEY.test(k) && v.length > 0 ? `****** (${v.length} ký tự)` : v;
    console.log(`  ${k}=${masked}`);
  }
  if (!reveal && keys.some((k) => SECRET_KEY.test(k))) console.log("\n  (giá trị bí mật đã che — thêm --reveal để xem)");
}

export function mergeEnvFile(path: string, updates: Record<string, string>, mode = 0o600): void {
  const current = parseEnvFile(path);
  const merged = { ...current, ...updates };
  writeFile(path, serializeEnv(merged), mode);
}

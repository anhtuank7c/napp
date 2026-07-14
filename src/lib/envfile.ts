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
export function mergeEnvFile(path: string, updates: Record<string, string>, mode = 0o600): void {
  const current = parseEnvFile(path);
  const merged = { ...current, ...updates };
  writeFile(path, serializeEnv(merged), mode);
}

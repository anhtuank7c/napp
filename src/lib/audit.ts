import { openSync, writeSync, closeSync, mkdirSync, existsSync, readFileSync, constants } from "node:fs";
import { userInfo } from "node:os";
import { state as execState } from "./exec";

// --------------------------------------------------------------------------
// Nhật ký thao tác (OWASP A09): ai đã xoá app, drop database, đổi tường lửa...
// qua napp. Máy thường có nhiều người cùng 'sudo napp' — không có dòng này thì
// sự cố xảy ra xong không có gì để lần lại.
//
// Mỗi dòng một JSON (dễ grep / đẩy sang hệ thống log khác). Bí mật trong lệnh
// (token, mật khẩu, giá trị biến môi trường) được CHE trước khi ghi. Xoay vòng
// bởi /etc/logrotate.d/napp (giữ 52 tuần).
// --------------------------------------------------------------------------

export const AUDIT_LOG = "/var/log/napp/audit.log";
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

// Lệnh chỉ đọc: không ghi nhật ký (chỉ làm nhiễu).
const READ_ONLY_VERBS = new Set(["list", "show", "logs", "help", "version", "changelog", "sample"]);
// Cờ mang bí mật ở tham số KẾ TIẾP (hoặc dạng --cờ=giá-trị).
const SECRET_FLAGS = ["--token", "--ssh-key", "--password", "--email"];

/** Che bí mật trong một dòng lệnh trước khi ghi nhật ký. */
export function redactArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = SECRET_FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
    if (flag) {
      if (a === flag) {
        out.push(a, "***");
        i++;
      } else out.push(`${flag}=***`);
      continue;
    }
    // KEY=VALUE (env set, --env): giữ tên biến, che giá trị.
    const kv = /^([A-Z_][A-Z0-9_]*)=(.*)$/s.exec(a);
    if (kv) {
      out.push(`${kv[1]}=***`);
      continue;
    }
    // URL có user:pass@ (repo, DATABASE_URL...)
    out.push(a.replace(/(\/\/[^/@\s:]+:)[^@\s/]+@/g, "$1***@"));
  }
  return out;
}

/** Lệnh (đường dẫn lệnh commander, vd ["app","delete"]) có thay đổi hệ thống không. */
export function isStateChanging(path: string[], args: string[]): boolean {
  const verb = path[path.length - 1] ?? "";
  if (READ_ONLY_VERBS.has(verb)) return false;
  if (path[0] === "check") return args.includes("--fix") || args.some((a) => a.startsWith("--db"));
  if (path[0] === "doctor") return path.includes("upgrade");
  if (path[0] === "tune" && verb === "show") return false;
  return true;
}

function actor(): string {
  const sudo = process.env.SUDO_USER;
  let who = "?";
  try {
    who = userInfo().username;
  } catch {
    /* container không có passwd entry */
  }
  return sudo ? `${sudo} (sudo -> ${who})` : who;
}

/**
 * Ghi một dòng nhật ký. KHÔNG BAO GIỜ làm hỏng thao tác chính: lỗi ghi nhật ký
 * (đĩa đầy, không phải root...) bị bỏ qua lặng lẽ.
 */
export function audit(entry: { command: string; via: "cli" | "menu"; result: "ok" | "error" | "cancelled"; error?: string }): void {
  if (execState.dryRun) return;
  if (process.getuid && process.getuid() !== 0) return;
  try {
    mkdirSync("/var/log/napp", { recursive: true, mode: 0o750 });
    const line =
      JSON.stringify({
        time: new Date().toISOString(),
        user: actor(),
        via: entry.via,
        command: entry.command,
        result: entry.result,
        ...(entry.error ? { error: entry.error.split("\n")[0]!.slice(0, 300) } : {}),
      }) + "\n";
    const fd = openSync(AUDIT_LOG, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | O_NOFOLLOW, 0o640);
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* không để nhật ký làm hỏng lệnh */
  }
}

/** In N dòng nhật ký gần nhất, dạng dễ đọc. */
export function cmdAuditShow(opts: { last: number }): void {
  if (!existsSync(AUDIT_LOG)) {
    console.log(`Chưa có nhật ký thao tác (${AUDIT_LOG}).`);
    return;
  }
  const lines = readFileSync(AUDIT_LOG, "utf8").trim().split("\n").filter(Boolean).slice(-opts.last);
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { time: string; user: string; via: string; command: string; result: string; error?: string };
      const mark = e.result === "ok" ? "✓" : e.result === "cancelled" ? "·" : "✗";
      console.log(`${e.time.replace("T", " ").slice(0, 19)}  ${mark} ${e.user.padEnd(22)} ${e.via.padEnd(4)} napp ${e.command}${e.error ? `  — ${e.error}` : ""}`);
    } catch {
      console.log(l);
    }
  }
}

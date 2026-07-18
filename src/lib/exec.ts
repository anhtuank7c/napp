import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { dryRunNotice, die } from "./log";

// Cờ toàn cục --dry-run, được set một lần khi parse CLI args ở index.ts.
// Cùng tinh thần với biến DRY_RUN trong lara.sh: mọi lệnh THAY ĐỔI hệ thống
// phải đi qua runCmd/runAs/writeFile để tôn trọng dry-run; lệnh chỉ đọc thì
// gọi execCapture trực tiếp.
export const state = { dryRun: false, verbose: false };

export function setDryRun(v: boolean): void {
  state.dryRun = v;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Chạy lệnh và LUÔN trả kết quả (không throw), dùng cho các thao tác chỉ đọc
// hoặc khi caller tự muốn xử lý mã lỗi (vd: kiểm tra service có đang chạy).
export function execCapture(cmd: string, args: string[] = []): RunResult {
  const opts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
  };
  const res = spawnSync(cmd, args, opts);
  if (res.error) {
    return { code: 127, stdout: "", stderr: String(res.error.message) };
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function commandExists(cmd: string): boolean {
  const res = execCapture("bash", ["-lc", `command -v ${shQuote(cmd)}`]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

// Quote an toàn cho bash -lc (dùng khi cần build một dòng lệnh phức hợp,
// ví dụ pipe). Ưu tiên truyền args dạng mảng cho spawnSync bất cứ khi nào có
// thể — shQuote chỉ dùng khi thực sự cần một chuỗi lệnh (ví dụ heredoc, pipe).
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Thực thi một lệnh THAY ĐỔI hệ thống. Ở chế độ --dry-run: chỉ in ra, không
// chạy thật. Ném NappError (qua die) nếu lệnh thất bại và không silent.
export function runCmd(
  cmd: string,
  args: string[] = [],
  opts: { silentFail?: boolean; input?: string } = {}
): RunResult {
  const display = [cmd, ...args].join(" ");
  if (state.dryRun) {
    dryRunNotice(display);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (state.verbose) dryRunNotice(`+ ${display}`);
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    input: opts.input,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.error) {
    if (opts.silentFail) return { code: 127, stdout: "", stderr: String(res.error.message) };
    die(`Không thể chạy lệnh '${cmd}': ${res.error.message}`);
  }
  const code = res.status ?? 1;
  if (code !== 0 && !opts.silentFail) {
    die(`Lệnh thất bại (mã ${code}): ${display}`);
  }
  return { code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Chạy lệnh dưới quyền một user hệ thống khác (tương đương run_as trong
// lara.sh, dùng `sudo -u`). Dùng để clone repo, cài npm packages, build app
// v.v. dưới đúng user sở hữu, tránh việc root sở hữu file của app.
export function runAs(
  user: string,
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; env?: Record<string, string>; silentFail?: boolean } = {}
): RunResult {
  const display = `(chạy bằng user ${user}${opts.cwd ? `, cwd ${opts.cwd}` : ""}) ${[cmd, ...args].join(" ")}`;
  if (state.dryRun) {
    dryRunNotice(display);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (state.verbose) dryRunNotice(`+ ${display}`);
  const sudoArgs = ["-u", user, "-H", "env"];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) sudoArgs.push(`${k}=${v}`);
  }
  sudoArgs.push(cmd, ...args);
  // KHÔNG dùng `sudo --chdir` (tương đương -D): nhiều cấu hình sudoers mặc
  // định CHẶN quyền đổi thư mục làm việc qua cờ này ("not permitted to use
  // the -D option"). Thay vào đó, đặt cwd ngay trên tiến trình spawn sudo —
  // sudo kế thừa thư mục làm việc này khi exec sang user khác, không cần
  // quyền đặc biệt nào trong sudoers.
  const res = spawnSync("sudo", sudoArgs, { encoding: "utf8", stdio: "inherit", cwd: opts.cwd });
  if (res.error) {
    if (opts.silentFail) return { code: 127, stdout: "", stderr: String(res.error.message) };
    const hint = /ENOENT/.test(String(res.error.message))
      ? " ('sudo' chưa được cài trên máy này — chạy 'napp check --fix' trước.)"
      : "";
    die(`Không thể chạy lệnh với user ${user}: ${res.error.message}${hint}`);
  }
  const code = res.status ?? 1;
  if (code !== 0 && !opts.silentFail) die(`Lệnh thất bại (mã ${code}) dưới user ${user}: ${display}`);
  return { code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Ghi nội dung ra file. Dry-run: chỉ in preview. Thật: tạo thư mục cha, ghi
// file, và có thể chmod ngay (mặc định 0644).
export function writeFile(path: string, content: string, mode = 0o644): void {
  if (state.dryRun) {
    dryRunNotice(`Sẽ ghi file ${path} (${content.length} bytes, mode ${mode.toString(8)})`);
    if (state.verbose) {
      console.log(
        content
          .split("\n")
          .map((l) => `  | ${l}`)
          .join("\n")
      );
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
  chmodSync(path, mode);
}

// Nối thêm nội dung vào cuối file (giữ nguyên phần đã có). Dùng để chèn khối
// ghi chú/gợi ý vào .env SAU khi mergeEnvFile đã ghi các cặp KEY=VALUE — vì
// mergeEnvFile chỉ serialize KEY=VALUE nên comment phải append riêng ở đây.
export function appendFile(path: string, content: string): void {
  if (state.dryRun) {
    dryRunNotice(`Sẽ nối thêm vào file ${path} (${content.length} bytes)`);
    return;
  }
  appendFileSync(path, content, { encoding: "utf8" });
}

export function ensureDir(path: string, mode = 0o755): void {
  if (state.dryRun) {
    if (!existsSync(path)) dryRunNotice(`Sẽ tạo thư mục ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true, mode });
}

export function requireRoot(): void {
  if (process.getuid && process.getuid() !== 0) {
    die("Lệnh này cần quyền root. Hãy chạy lại với sudo.");
  }
}

export function isServiceActive(name: string): boolean {
  return execCapture("systemctl", ["is-active", "--quiet", name]).code === 0;
}

export function isServiceEnabled(name: string): boolean {
  return execCapture("systemctl", ["is-enabled", "--quiet", name]).code === 0;
}

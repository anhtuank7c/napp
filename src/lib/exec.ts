import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdirSync, existsSync, statSync, accessSync, lstatSync, openSync, writeSync, closeSync, fchmodSync, fchownSync, fsyncSync, renameSync, rmSync, constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, basename, delimiter } from "node:path";
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
export function execCapture(cmd: string, args: string[] = [], extra: { input?: string } = {}): RunResult {
  // input: đưa dữ liệu qua stdin — dùng cho bí mật (vd 'AUTH <mật khẩu>' cho
  // redis-cli) để chúng không bao giờ nằm trong argv, nơi mọi user đọc được qua 'ps'.
  const opts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 32,
    ...(extra.input !== undefined ? { input: extra.input } : {}),
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

// Thư mục chương trình hệ thống — luôn xét, kể cả khi PATH hiện tại thiếu (vd
// chạy từ systemd timer, hoặc PATH của sudo không có sbin).
const SYSTEM_BIN_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/snap/bin"];

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Mọi đường dẫn thực thi được của `cmd` trên PATH + thư mục hệ thống, theo thứ tự. */
export function whichAll(cmd: string): string[] {
  if (cmd.includes("/")) return isExecutableFile(cmd) ? [cmd] : [];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...SYSTEM_BIN_DIRS].filter(Boolean);
  // Windows (chỉ máy dev): chương trình mang đuôi .exe/.cmd... theo PATHEXT.
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").toLowerCase().split(";")] : [""];
  const out: string[] = [];
  for (const d of [...new Set(dirs)]) {
    for (const ext of exts) {
      const p = join(d, cmd + ext);
      if (isExecutableFile(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

// Tra NGAY trong tiến trình, không mở shell. Trước đây mỗi lần hỏi là một login
// shell ('bash -lc command -v ...'): nạp lại /etc/profile + .bashrc (+ nvm nếu có)
// — 100-500ms MỖI LẦN, gọi ở 46 chỗ, nhiều nhất cho engine CHƯA cài (3/4 engine
// trên máy thường). Đó là nguồn chính của cảm giác "napp lag": menu "Kiểm tra &
// sửa môi trường" mất ~665ms chỉ để vẽ, gần như toàn bộ là mấy login shell này.
//
// Không cache: 'check --fix' cài chương trình rồi kiểm tra lại ngay trong cùng
// một lần chạy; tra thẳng filesystem chỉ tốn vài micro-giây.
export function commandExists(cmd: string): boolean {
  return whichAll(cmd).length > 0;
}

// Quote an toàn cho bash -lc (dùng khi cần build một dòng lệnh phức hợp,
// ví dụ pipe). Ưu tiên truyền args dạng mảng cho spawnSync bất cứ khi nào có
// thể — shQuote chỉ dùng khi thực sự cần một chuỗi lệnh (ví dụ heredoc, pipe).
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Thông báo khi một lệnh hệ thống (apt, git, certbot, systemctl, mysql...) thất
// bại. Mục tiêu: người đọc biết NGAY chuyện gì xảy ra và làm gì tiếp, thay vì
// một dòng "mã 1" trơ trọi.
function failureMessage(
  cmd: string,
  display: string,
  res: { status: number | null; signal: NodeJS.Signals | null; error?: Error; stdout?: string | null; stderr?: string | null },
  captured: boolean,
  who = ""
): string {
  if (res.error) {
    if (/ENOENT/.test(res.error.message)) {
      return `Không tìm thấy chương trình '${cmd}' trên máy này${who}. Cài gói chứa nó (thường là: sudo napp check --fix) rồi thử lại.`;
    }
    return `Không chạy được '${cmd}'${who}: ${res.error.message}`;
  }
  if (res.signal) {
    return (
      `Lệnh bị ngắt bởi tín hiệu ${res.signal}${res.signal === "SIGINT" ? " (Ctrl+C)" : ""}${who}: ${display}\n` +
      `  Việc đang làm dở có thể chưa hoàn tất — chạy lại thao tác này khi sẵn sàng.`
    );
  }
  const head = `Lệnh thất bại (mã ${res.status ?? 1})${who}: ${display}`;
  if (!captured) {
    // stdio kế thừa: lỗi thật của chương trình đã in ra màn hình ngay phía trên.
    return `${head}\n  Nguyên nhân cụ thể là thông báo của chính '${cmd}' in ngay phía trên dòng này.`;
  }
  // stdio bị bắt (vd gửi SQL qua stdin): phải tự in lại, không thì mất sạch.
  const out = `${res.stderr ?? ""}\n${res.stdout ?? ""}`
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (out.length === 0) return head;
  const tail = out.slice(-15).map((l) => `    ${l}`).join("\n");
  return `${head}\n  Thông báo của '${cmd}':\n${tail}`;
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
    die(failureMessage(cmd, display, res, opts.input !== undefined));
  }
  const code = res.status ?? 1;
  if (code !== 0 && !opts.silentFail) {
    die(failureMessage(cmd, display, res, opts.input !== undefined));
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
  //
  // Mặc định cwd = "/" khi caller không chỉ định: nếu để kế thừa CWD của tiến
  // trình napp (thường là /root khi chạy `sudo napp`), user hệ thống của app
  // KHÔNG có quyền vào đó -> shell con phun cảnh báo "getcwd: cannot access
  // parent directories". "/" thì mọi user đều traverse được, hết cảnh báo.
  const res = spawnSync("sudo", sudoArgs, { encoding: "utf8", stdio: "inherit", cwd: opts.cwd ?? "/" });
  if (res.error) {
    if (opts.silentFail) return { code: 127, stdout: "", stderr: String(res.error.message) };
    // spawn ở đây là 'sudo' — ENOENT nghĩa là thiếu sudo, không phải thiếu lệnh con.
    die(failureMessage("sudo", display, res, false));
  }
  const code = res.status ?? 1;
  if (code !== 0 && !opts.silentFail) die(failureMessage(cmd, display, res, false, ` (chạy bằng user ${user})`));
  return { code, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Chạy lệnh CHỈ ĐỌC dưới quyền user khác và LẤY output về. Khác runAs: runAs
// kế thừa stdio (in thẳng ra màn hình, không đọc được kết quả) và tôn trọng
// dry-run vì nó dùng cho lệnh thay đổi hệ thống. Hàm này dùng cho các bước
// quét/audit — phải chạy đúng user của app để cache (npm/pnpm/bun) không bị
// root tạo ra trong thư mục app, và KHÔNG bị dry-run chặn vì không đổi gì.
export function execCaptureAs(
  user: string,
  cmd: string,
  args: string[] = [],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): RunResult {
  // -n (non-interactive): nếu sudo cần mật khẩu thì THOÁT NGAY thay vì chờ gõ.
  // Bắt buộc vì stdio ở đây là pipe — prompt mật khẩu sẽ treo vô hạn.
  const sudoArgs = ["-n", "-u", user, "-H", "env"];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) sudoArgs.push(`${k}=${v}`);
  }
  sudoArgs.push(cmd, ...args);
  const res = spawnSync("sudo", sudoArgs, {
    encoding: "utf8",
    cwd: opts.cwd ?? "/",
    timeout: opts.timeoutMs,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.error) {
    // Quá thời gian chờ (ETIMEDOUT) cũng vào nhánh này — trả mã lỗi để caller
    // báo "không chạy được audit" thay vì làm hỏng cả phiên quét.
    return { code: 127, stdout: res.stdout ?? "", stderr: String(res.error.message) };
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Ghi nội dung ra file. Dry-run: chỉ in preview. Thật: tạo thư mục cha, ghi
// file, và có thể chmod ngay (mặc định 0644).
// O_NOFOLLOW không có trên Windows (máy dev) — 0 = bỏ qua.
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** uid/gid của một user hệ thống (để tạo file đã đúng chủ, không cần chown sau). */
export function userIds(user: string): { uid: number; gid: number } {
  const uid = parseInt(execCapture("id", ["-u", user]).stdout.trim(), 10);
  const gid = parseInt(execCapture("id", ["-g", user]).stdout.trim(), 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) die(`Không tìm thấy user hệ thống '${user}'.`);
  return { uid, gid };
}

/** gid của một nhóm hệ thống. */
export function groupId(group: string): number {
  const line = execCapture("getent", ["group", group]).stdout.trim();
  const gid = parseInt(line.split(":")[2] ?? "", 10);
  if (!Number.isInteger(gid)) die(`Không tìm thấy nhóm hệ thống '${group}'.`);
  return gid;
}

/** Từ chối nếu `path` là symlink — dùng trước khi root ĐỌC file nằm trong thư mục của app. */
export function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      die(
        `${path} là một symlink — napp (chạy bằng root) từ chối đọc/ghi qua nó.\n` +
          `  File này nằm trong thư mục do app sở hữu; symlink ở đây có thể trỏ tới file của root\n` +
          `  (vd /etc/shadow). Thay nó bằng một file thường rồi thử lại.`
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * chmod KHÔNG đi theo symlink ('chmod' của hệ thống luôn đi theo). Dùng cho file
 * nằm trong thư mục do app sở hữu: một repo git có thể commit '.env' là symlink
 * tới /etc/passwd, và 'chmod 600 .env' sau deploy sẽ khoá luôn mọi đăng nhập.
 * Là symlink -> bỏ qua kèm cảnh báo.
 */
export function chmodNoFollow(path: string, mode: number): void {
  if (state.dryRun) {
    dryRunNotice(`chmod ${mode.toString(8)} ${path} (không theo symlink)`);
    return;
  }
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ELOOP") {
      console.error(`[CẢNH BÁO] ${path} là symlink — bỏ qua chmod (napp không đổi quyền file qua symlink).`);
      return;
    }
    throw e;
  }
  try {
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

/**
 * Ghi file AN TOÀN khi chạy bằng root:
 *  - tạo một file tạm MỚI (O_EXCL, không theo symlink) ngay trong thư mục đích,
 *    với ĐÚNG mode và (nếu có) đúng chủ sở hữu NGAY TỪ LÚC TẠO — không có khoảnh
 *    khắc nào file chứa bí mật (.env, token) mang quyền 0644;
 *  - rồi rename đè lên đích. rename THAY THẾ một symlink chứ không đi theo nó.
 *
 * Vì sao quan trọng: nhiều file napp ghi nằm trong thư mục do user của app sở
 * hữu (.env, .git-credentials). Trước đây ghi thẳng + 'chown' theo đường dẫn:
 * app (hoặc một repo git có commit '.env' là symlink) đổi .env thành symlink tới
 * /etc/shadow là napp — bằng quyền root — ghi đè VÀ chown file đó cho app.
 */
export function writeFile(path: string, content: string, mode = 0o644, opts: { owner?: string; group?: string } = {}): void {
  if (state.dryRun) {
    dryRunNotice(`Sẽ ghi file ${path} (${content.length} bytes, mode ${mode.toString(8)}${opts.owner ? `, chủ ${opts.owner}` : ""})`);
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
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // owner: chủ + nhóm chính của user đó. group (không có owner): root + nhóm này
  // (vd cấu hình Redis 0640 root:nr_<id> — tiến trình Redis đọc được, không sửa được).
  const ids = opts.owner
    ? { uid: userIds(opts.owner).uid, gid: opts.group ? groupId(opts.group) : userIds(opts.owner).gid }
    : opts.group
      ? { uid: 0, gid: groupId(opts.group) }
      : undefined;
  const tmp = join(dir, `.${basename(path)}.napp-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, mode);
  try {
    writeSync(fd, content, null, "utf8");
    fchmodSync(fd, mode); // mode lúc tạo còn bị umask cắt bớt
    if (ids) fchownSync(fd, ids.uid, ids.gid);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

// Nối thêm nội dung vào cuối file (giữ nguyên phần đã có). Dùng để chèn khối
// ghi chú/gợi ý vào .env SAU khi mergeEnvFile đã ghi các cặp KEY=VALUE — vì
// mergeEnvFile chỉ serialize KEY=VALUE nên comment phải append riêng ở đây.
export function appendFile(path: string, content: string): void {
  if (state.dryRun) {
    dryRunNotice(`Sẽ nối thêm vào file ${path} (${content.length} bytes)`);
    return;
  }
  // O_NOFOLLOW: không nối vào file của root qua một symlink đặt sẵn.
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | O_NOFOLLOW);
  try {
    writeSync(fd, content, null, "utf8");
  } finally {
    closeSync(fd);
  }
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

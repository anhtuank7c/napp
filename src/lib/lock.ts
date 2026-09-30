import { openSync, writeSync, closeSync, readSync, existsSync, unlinkSync, mkdirSync, lstatSync, chmodSync, constants } from "node:fs";
import { die, warn } from "./log";
import { state as execState } from "./exec";

// Thư mục CHỈ root ghi được. Trước đây là /run/lock (mọi user đều ghi được):
// bất kỳ ai cũng tạo sẵn được 'napp-<domain>.lock' chứa PID một tiến trình của
// họ là chặn mọi thao tác napp trên domain đó.
const LOCK_DIR = "/run/napp";
const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function ensureLockDir(): void {
  mkdirSync(LOCK_DIR, { recursive: true, mode: 0o700 });
  const st = lstatSync(LOCK_DIR);
  if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid && st.uid !== 0)) {
    die(`${LOCK_DIR} không phải thư mục của root — từ chối dùng làm chỗ đặt lock.`);
  }
  chmodSync(LOCK_DIR, 0o700);
}

/** Đọc PID trong lock file mà KHÔNG đi theo symlink. */
function readLockPid(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

function lockPath(domain: string): string {
  return `${LOCK_DIR}/napp-${domain}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Khoá đơn giản dựa trên file + O_EXCL (tương đương flock trong lara.sh).
// Trả về hàm release(); nếu domain đang bị khoá bởi một tiến trình napp khác
// còn sống thì die() ngay. Lock file chứa PID để tự dọn nếu tiến trình cũ
// đã chết (crash) mà chưa kịp release.
export function acquireLock(domain: string): () => void {
  if (execState.dryRun) return () => {};
  ensureLockDir();
  const path = lockPath(domain);

  if (existsSync(path)) {
    const raw = readLockPid(path);
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && pidAlive(pid)) {
      die(`Đang có một tiến trình napp khác (PID ${pid}) thao tác trên '${domain}'. Hãy đợi nó hoàn tất rồi thử lại.`);
    }
    warn(`Tìm thấy lock cũ của '${domain}' (PID ${raw} đã chết) — tự dọn dẹp.`);
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }

  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW, 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    die(`Không tạo được lock file ${path}. Có thể do đua tranh — hãy thử lại.`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  };
}

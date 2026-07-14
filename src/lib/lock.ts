import { openSync, writeSync, closeSync, readFileSync, existsSync, unlinkSync, constants } from "node:fs";
import { die, warn } from "./log";
import { state as execState } from "./exec";

const LOCK_DIR = "/run/lock";

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
  const path = lockPath(domain);

  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
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
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
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

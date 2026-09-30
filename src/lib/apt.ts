import { existsSync, readFileSync, statSync } from "node:fs";
import { execCapture, commandExists, runCmd, state as execState, type RunResult } from "./exec";
import { info, warn } from "./log";

// --------------------------------------------------------------------------
// Đọc trạng thái BẢN VÁ của hệ thống qua apt (Ubuntu/Debian).
//
// Vì sao KHÔNG so sánh số phiên bản với danh sách CVE là đủ: Ubuntu/Debian
// BACKPORT bản vá vào phiên bản cũ (nginx 1.24.0-2ubuntu7.5 đã có vá của CVE
// mà upstream sửa ở 1.27.x) — số phiên bản upstream nhìn vẫn "cũ". Nguồn tin
// cậy nhất trên máy là: apt có gói nào đang chờ nâng cấp từ kho '-security'
// hay không. Danh sách CVE (lib/cve.ts) chỉ đóng vai trò gợi ý bổ sung.
// --------------------------------------------------------------------------

export interface PendingUpdate {
  pkg: string;
  currentVersion: string; // rỗng nếu là gói mới được kéo vào
  newVersion: string;
  origins: string; // vd: "Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]"
  security: boolean;
}

// Các gói ĐỤNG TRỰC TIẾP tới bề mặt tấn công của một VPS chạy web: lộ ra
// Internet (nginx/openssh), xử lý dữ liệu không tin cậy (openssl/zlib/curl),
// hoặc chạy mã ứng dụng (nodejs). Bản vá cho nhóm này cần ưu tiên cao hơn.
const CRITICAL_PKG_RE =
  /^(nginx|nginx-\w+|openssl|libssl[0-9.]*|libcrypto\S*|openssh-\S+|libc6|libc-bin|zlib1g|libcurl\S*|curl|nodejs|npm|mariadb-\S+|mysql-\S+|libmariadb\S*|postgresql\S*|libpq\S*|mongodb-\S+|redis\S*|certbot|python3-certbot\S*|sudo|systemd|libsystemd\S*|libexpat\S*|libxml2|libpcre\S*|git)$/;

export function hasApt(): boolean {
  return commandExists("apt-get");
}

export function isCriticalPackage(pkg: string): boolean {
  return CRITICAL_PKG_RE.test(pkg);
}

// Tuổi của chỉ mục apt (giây). Chỉ mục cũ -> "không có bản vá chờ" là kết luận
// KHÔNG đáng tin, phải cảnh báo người dùng chạy 'apt-get update' trước.
export function aptIndexAgeSeconds(): number | undefined {
  for (const p of ["/var/lib/apt/periodic/update-success-stamp", "/var/cache/apt/pkgcache.bin", "/var/lib/apt/lists"]) {
    try {
      return Math.floor((Date.now() - statSync(p).mtimeMs) / 1000);
    } catch {
      /* thử đường dẫn kế tiếp */
    }
  }
  return undefined;
}

// Danh sách gói đang chờ nâng cấp. Dùng 'apt-get -s dist-upgrade' (SIMULATE,
// không đổi gì) + Debug::NoLocking để chạy được cả khi KHÔNG phải root.
export function pendingUpdates(): PendingUpdate[] {
  if (!hasApt()) return [];
  const res = execCapture("apt-get", ["-s", "-q", "-o", "Debug::NoLocking=1", "dist-upgrade"]);
  if (res.code !== 0 && !res.stdout) return [];
  const out: PendingUpdate[] = [];
  for (const line of res.stdout.split("\n")) {
    // Inst nginx-common [1.24.0-2ubuntu7.1] (1.24.0-2ubuntu7.3 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [all])
    const m = line.match(/^Inst\s+(\S+)\s+(?:\[([^\]]*)\]\s+)?\(([^\s)]+)\s+([^)]*)\)/);
    if (!m) continue;
    const origins = m[4] ?? "";
    out.push({
      pkg: m[1]!,
      currentVersion: m[2] ?? "",
      newVersion: m[3]!,
      origins,
      // Ubuntu: ".../noble-security"; Debian: "Debian:12/oldstable-security" hoặc "Debian-Security:12".
      security: /security/i.test(origins),
    });
  }
  return out;
}

// Máy cần khởi động lại (thường sau khi vá kernel/libc).
export function rebootRequired(): { required: boolean; packages: string[] } {
  const flag = "/var/run/reboot-required";
  if (!existsSync(flag)) return { required: false, packages: [] };
  let packages: string[] = [];
  try {
    packages = readFileSync(`${flag}.pkgs`, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    /* file .pkgs là tuỳ chọn */
  }
  return { required: true, packages: [...new Set(packages)] };
}

// Tiến trình còn ĐANG DÙNG thư viện đã bị xoá/thay thế trên đĩa -> đã vá gói
// nhưng tiến trình vẫn chạy mã CŨ trong RAM cho tới khi restart. Đây là cái bẫy
// kinh điển: 'apt upgrade' xong tưởng đã an toàn nhưng nginx vẫn nạp libssl cũ.
//
// Cách phát hiện: đọc /proc/<pid>/maps, tìm file đã map nhưng bị đánh dấu
// "(deleted)" — chính là cách needrestart làm, không cần cài thêm gói nào.
// Trả về undefined khi không đọc được (không phải root / unit không chạy).
export function unitStaleLibraries(unit: string): string[] | undefined {
  const pidOut = execCapture("systemctl", ["show", "-p", "MainPID", "--value", unit]).stdout.trim();
  const pid = parseInt(pidOut, 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  let maps: string;
  try {
    maps = readFileSync(`/proc/${pid}/maps`, "utf8");
  } catch {
    return undefined; // cần quyền root để đọc maps của tiến trình khác
  }
  const stale = new Set<string>();
  for (const line of maps.split("\n")) {
    const m = line.match(/\s(\/\S.*?)\s+\(deleted\)$/);
    if (!m) continue;
    const path = m[1]!;
    // Bỏ qua các map ẢO bị đánh dấu deleted trong đời sống bình thường của
    // tiến trình (memfd, shm, dev) — chúng không liên quan tới việc vá gói.
    if (/^\/(memfd:|dev\/|SYSV|drm|anon_|\[)/.test(path)) continue;
    if (!/\.so($|\.)|^\/usr\/(s?bin|lib|libexec)\//.test(path)) continue;
    stale.add(path);
  }
  return [...stale];
}

// --------------------------------------------------------------------------
// Chờ khoá apt/dpkg.
//
// Cái bẫy gặp NGAY lần đầu trên VPS mới: unattended-upgrades chạy trong vài
// phút đầu sau khi máy khởi động và giữ khoá dpkg — mọi 'apt-get install' lúc
// đó chết ngay với "Could not get lock /var/lib/dpkg/lock-frontend". Người dùng
// tưởng napp hỏng, trong khi chỉ cần đợi.
//
// Hai lớp: (1) tự đợi tới khi không còn tiến trình nào giữ khoá (bao cả khoá
// danh sách gói mà 'apt-get update' cần), (2) DPkg::Lock::Timeout để apt tự
// đợi thêm nếu có tiến trình giành khoá ngay giữa hai lệnh.
// --------------------------------------------------------------------------

export const APT_LOCK_TIMEOUT_S = 300;
const APT_LOCKS = ["/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"];

function aptLockHolders(): string[] {
  // fuser (gói psmisc, có sẵn trên Ubuntu/Debian): mã 0 = có tiến trình đang giữ.
  const res = execCapture("fuser", APT_LOCKS);
  if (res.code !== 0) return [];
  // fuser in PID ra stdout, đường dẫn file ra stderr — chỉ đọc stdout.
  const pids = res.stdout.match(/[0-9]+/g) ?? [];
  return [...new Set(pids)].map((pid) => {
    const name = execCapture("ps", ["-o", "comm=", "-p", pid]).stdout.trim();
    return name ? `${name} (pid ${pid})` : `pid ${pid}`;
  });
}

export function waitForAptLocks(timeoutS = APT_LOCK_TIMEOUT_S): void {
  if (execState.dryRun || !commandExists("fuser")) return;
  let holders = aptLockHolders();
  if (holders.length === 0) return;
  info(`apt đang bận (${holders.join(", ")} — thường là unattended-upgrades trên máy mới khởi động). Đang chờ tối đa ${Math.round(timeoutS / 60)} phút...`);
  const deadline = Date.now() + timeoutS * 1000;
  while (holders.length > 0 && Date.now() < deadline) {
    execCapture("sleep", ["3"]);
    holders = aptLockHolders();
  }
  if (holders.length > 0) warn(`apt vẫn bận sau ${Math.round(timeoutS / 60)} phút (${holders.join(", ")}) — vẫn thử chạy tiếp.`);
  else info("apt đã rảnh — tiếp tục.");
}

/** 'apt-get' đợi khoá thay vì chết ngay khi apt đang bận. Mọi lệnh apt thay đổi hệ thống nên đi qua đây. */
export function aptGet(args: string[], opts: { silentFail?: boolean } = {}): RunResult {
  waitForAptLocks();
  return runCmd("apt-get", ["-o", `DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_S}`, ...args], opts);
}

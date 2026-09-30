import { randomBytes } from "node:crypto";
import { execCapture, isServiceActive, state as execState } from "../exec";
import { aptGet } from "../apt";
import { die, warn } from "../log";

// Mật khẩu hex: an toàn khi nhúng vào SQL, URL (DATABASE_URL) và .env mà không
// cần escape gì — cố ý không dùng ký tự đặc biệt.
export function randomPassword(): string {
  return randomBytes(16).toString("hex");
}

// Gói apt đã cài thật (trạng thái "install ok installed"), không tính gói chỉ
// còn file cấu hình sau khi 'apt remove' (trạng thái "deinstall ok config-files").
export function dpkgInstalled(pkg: string): boolean {
  const res = execCapture("dpkg-query", ["-W", "-f=${Status}", pkg]);
  return res.code === 0 && /install ok installed/.test(res.stdout);
}

export function anyUnitActive(units: string[]): boolean {
  return units.some((u) => isServiceActive(u));
}

export function processRunning(names: string[]): boolean {
  return names.some((n) => execCapture("pgrep", ["-x", n]).code === 0);
}

export function aptInstall(pkgs: string[]): void {
  aptGet(["update"]);
  aptGet(["install", "-y", ...pkgs]);
}

// Gỡ gói. Mặc định 'remove' GIỮ dữ liệu + file cấu hình (cài lại là dùng tiếp);
// 'purge' xoá cấu hình, và caller tự xoá thư mục dữ liệu nếu người dùng yêu cầu.
export function aptRemove(pkgs: string[], purge: boolean): void {
  // Chỉ gỡ gói đang thật sự có — apt-get báo lỗi với tên gói không tồn tại.
  const present = pkgs.filter((p) => execCapture("dpkg-query", ["-W", "-f=${Status}", p]).code === 0);
  if (present.length === 0) return;
  aptGet([purge ? "purge" : "remove", "-y", ...present]);
  if (purge) aptGet(["autoremove", "--purge", "-y"], { silentFail: true });
}

// --- Cổng đang lắng nghe ----------------------------------------------------

export interface PortListener {
  host: string; // "127.0.0.1", "::1", "0.0.0.0", "::", "*", "10.0.0.5"...
  port: number;
  process?: string;
  pid?: number;
}

// Đọc 'ss -ltnpH' rồi lọc theo cổng trong code, thay vì dùng cú pháp filter của
// ss (khác nhau giữa các bản iproute2). Cần root để thấy tên tiến trình.
export function portListeners(port: number): PortListener[] {
  const res = execCapture("ss", ["-ltnpH"]);
  return res.code === 0 ? parseSsListeners(res.stdout, port) : [];
}

export function parseSsListeners(stdout: string, port: number): PortListener[] {
  const out: PortListener[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const local = fields[3];
    if (!local) continue;
    const idx = local.lastIndexOf(":");
    if (parseInt(local.slice(idx + 1), 10) !== port) continue;
    // "[::1]:5432", "127.0.0.1%lo:53", "*:27017"
    const host = local.slice(0, idx).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const proc = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    out.push({ host, port, process: proc?.[1], pid: proc ? parseInt(proc[2]!, 10) : undefined });
  }
  return out;
}

function isLoopback(host: string): boolean {
  return /^127\./.test(host) || host === "::1" || host === "localhost";
}

/** Tiến trình lắng nghe cổng này trên địa chỉ KHÔNG phải loopback (lộ ra mạng). */
export function publicListeners(port: number): PortListener[] {
  return portListeners(port).filter((l) => !isLoopback(l.host));
}

export function describeListener(l: PortListener): string {
  return `${l.process ?? "tiến trình không rõ"}${l.pid ? ` (pid ${l.pid})` : ""} trên ${l.host}:${l.port}`;
}

// --- Kiểm tra trước khi cài -------------------------------------------------

// Dung lượng trống (MB) của phân vùng chứa đường dẫn — đi ngược lên cho tới
// thư mục có thật (thư mục dữ liệu chưa tồn tại trước khi cài).
function freeDiskMB(path: string): number | undefined {
  const res = execCapture("df", ["-BM", "--output=avail", path]);
  if (res.code !== 0) {
    const parent = path.replace(/\/[^/]+\/?$/, "");
    return parent && parent !== path ? freeDiskMB(parent) : undefined;
  }
  const v = parseInt(res.stdout.trim().split("\n").pop()?.replace("M", "") ?? "", 10);
  return Number.isFinite(v) ? v : undefined;
}

/**
 * Chặn TRƯỚC khi apt chạy, vì hai kiểu hỏng dưới đây mà để apt gặp thì rất khó gỡ:
 *
 * 1. Cổng đã bị chiếm (container Docker publish 5432, một MySQL cài tay...): apt
 *    cài xong, service không khởi động được, lý do thật nằm lẫn trong journalctl.
 * 2. Hết đĩa giữa chừng: dpkg bị bỏ dở ở trạng thái hỏng, phải 'dpkg --configure
 *    -a' bằng tay — tệ hơn nhiều so với một thông báo "không đủ chỗ" rõ ràng.
 */
export function preflightInstall(label: string, port: number, dataDir: string, minDiskMB: number): void {
  // --dry-run chỉ để xem trước: báo nhưng không chặn.
  const fail = (msg: string): void => (execState.dryRun ? warn(msg) : die(msg));

  const taken = portListeners(port);
  if (taken.length > 0) {
    const docker = taken.some((l) => /docker/.test(l.process ?? ""));
    fail(
      `Cổng ${port} (mặc định của ${label}) ĐANG bị chiếm bởi: ${taken.map(describeListener).join("; ")}.\n` +
        `  Cài tiếp thì ${label} sẽ không khởi động được.\n` +
        (docker
          ? `  Đây là một container Docker publish cổng ${port} — dừng container đó, hoặc đổi cổng publish của nó (vd -p 127.0.0.1:${port + 1}:${port}).`
          : `  Kiểm tra: sudo ss -ltnp | grep :${port} — nếu đó là một ${label} cài tay, nhận quản lý thay vì cài mới (napp db engine add <engine>).`)
    );
  }

  const free = freeDiskMB(dataDir);
  if (free !== undefined && free < minDiskMB) {
    fail(
      `Không đủ dung lượng đĩa để cài ${label}: còn ${free} MB trống ở phân vùng chứa ${dataDir}, cần tối thiểu ~${minDiskMB} MB.\n` +
        `  Hết đĩa giữa lúc apt đang cài sẽ để dpkg ở trạng thái hỏng. Dọn bớt (vd: sudo journalctl --vacuum-size=200M, sudo apt-get clean) rồi thử lại.`
    );
  }
}

// URL kết nối cho DATABASE_URL. Tên/user do validateDbName giới hạn [A-Za-z0-9_],
// mật khẩu là hex — không ký tự nào cần percent-encode.
export function connectionUrl(scheme: string, db: { name: string; user: string; password: string }, port: number, query = ""): string {
  return `${scheme}://${db.user}:${db.password}@127.0.0.1:${port}/${db.name}${query}`;
}

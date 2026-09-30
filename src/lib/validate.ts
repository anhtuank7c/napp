import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, dirname, sep } from "node:path";
import { die } from "./log";

const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function validateDomain(d: string): void {
  if (!DOMAIN_RE.test(d)) {
    die(`Tên miền không hợp lệ: '${d}' (ví dụ hợp lệ: api.example.com)`);
  }
  if (d.length > 253) die(`Tên miền quá dài: ${d}`);
}

// Tên background service (không phải domain): chữ thường/số/gạch ngang, bắt đầu
// bằng chữ-số, dài 1-63 ký tự. Đủ để làm slug user hệ thống + tên unit systemd
// an toàn, và tránh nhầm với domain (không có dấu chấm).
export function validateServiceName(name: string): void {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 63) {
    die(`Tên service không hợp lệ: '${name}' (chỉ chữ thường, số, gạch ngang; ví dụ: worker-telegram, queue-email).`);
  }
}

export function validatePort(p: number): void {
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    die(`Cổng không hợp lệ: ${p} (phải trong khoảng 1-65535)`);
  }
}

// Chỉ chấp nhận URL git an toàn — chặn transport thực thi lệnh (ext::, fd::),
// file://, chuỗi bắt đầu bằng '-' (argument injection), khoảng trắng/ký tự
// điều khiển. Cùng logic bảo mật với validate_repo_url() trong lara.sh.
export function validateRepoUrl(url: string, opts: { allowInsecure?: boolean } = {}): void {
  if (!url) die("URL git rỗng.");
  if (url.startsWith("-")) die(`URL git không được bắt đầu bằng '-': ${url}`);
  if (/[\s\x00-\x1f]/.test(url)) {
    die("URL git chứa khoảng trắng/ký tự điều khiển không hợp lệ.");
  }
  if (/^(ext|fd)::/.test(url) || url.startsWith("file://")) {
    die(`Transport git bị cấm vì lý do bảo mật: ${url}`);
  }
  // http:// và git:// KHÔNG mã hoá, KHÔNG kiểm tra toàn vẹn: ai đứng giữa đường
  // mạng (Wi-Fi công cộng, nhà mạng, proxy) sửa được mã nguồn napp sắp chạy.
  if (/^(http|git):\/\//.test(url) && !opts.allowInsecure) {
    die(
      `Repo dùng giao thức KHÔNG mã hoá: ${url}\n` +
        `  Ai đứng giữa đường mạng có thể sửa mã nguồn trước khi napp build và chạy nó.\n` +
        `  Dùng https:// hoặc SSH (git@host:path). Nếu thật sự cần (mạng nội bộ tin cậy): thêm --allow-insecure-repo.`
    );
  }
  const okPrefix = /^(https:\/\/|http:\/\/|git:\/\/|ssh:\/\/)/.test(url);
  const okScp = /^[^@\s]+@[^:\s]+:.+$/.test(url); // user@host:path
  if (!okPrefix && !okScp) {
    die(
      `URL git không hợp lệ: ${url}\n` +
        `  Chỉ chấp nhận https://, http://, ssh://, git:// hoặc dạng user@host:path.`
    );
  }
}

export function validateBranch(branch: string): void {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.startsWith("-")) {
    die(`Tên branch không hợp lệ: '${branch}'`);
  }
}

export function validateEnvKey(key: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    die(`Tên biến môi trường không hợp lệ: '${key}' (chỉ chữ hoa, số, gạch dưới, không bắt đầu bằng số)`);
  }
}

export function validateDbName(name: string, maxLength = 64): void {
  if (!/^[a-zA-Z0-9_]+$/.test(name) || name.length > maxLength) {
    die(`Tên database không hợp lệ: '${name}' (chỉ chữ, số, gạch dưới, tối đa ${maxLength} ký tự)`);
  }
}

// Chuyển "HH:MM" thành chuỗi OnCalendar của systemd cho lịch chạy HÀNG NGÀY
// (dùng chung cho các timer: backup, đồng bộ IP Cloudflare, ...).
export function timeToDailyOnCalendar(time: string): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) die(`Định dạng giờ không hợp lệ: '${time}' (ví dụ hợp lệ: 03:30)`);
  const hh = parseInt(m[1]!, 10);
  const mm = parseInt(m[2]!, 10);
  if (hh > 23 || mm > 59) die(`Giờ/phút không hợp lệ: '${time}'`);
  return `*-*-* ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

// --------------------------------------------------------------------------
// Giá trị đi vào cấu hình nginx của một app. nginx chạy bằng root khi nạp cấu
// hình; một giá trị có ';' hay '}' là chèn được directive tuỳ ý, còn một thư mục
// như '/' là publish MỌI file nginx đọc được (kể cả mã nguồn app khác — nginx
// được cho vào nhóm của từng app). 'nginx -t' KHÔNG bắt được cái sau: cấu hình
// đó hoàn toàn hợp lệ, chỉ là nguy hiểm.
// --------------------------------------------------------------------------

const URL_PREFIX_RE = /^\/[A-Za-z0-9._~\-/]*\/$/;
const HOTLINK_HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function validateUrlPrefix(p: string, flag: string): void {
  if (!URL_PREFIX_RE.test(p) || p.includes("//") || p.split("/").includes("..")) {
    die(`${flag} không hợp lệ: '${p}' (phải bắt đầu và kết thúc bằng '/', chỉ chữ, số, . _ ~ - /; vd '/_app/')`);
  }
}

export function validateMaxBody(v: string): void {
  const m = /^(\d{1,6})([kKmMgG]?)$/.exec(v);
  const mult = { "": 1, k: 1 / 1024, m: 1, g: 1024 }[(m?.[2] ?? "").toLowerCase() as "" | "k" | "m" | "g"];
  if (!m || Number(m[1]) * mult > 10 * 1024) die(`--max-body không hợp lệ: '${v}' (vd 20M, 512k, 1G; tối đa 10G)`);
}

export function validateHotlinkHost(h: string): void {
  if (!HOTLINK_HOST_RE.test(h) || h.length > 253) die(`--hotlink-allow không hợp lệ: '${h}' (tên miền, hoặc '*.tenmien.com')`);
}

/**
 * Thư mục nginx sẽ phục vụ phải nằm TRONG thư mục của chính app đó — tính cả
 * symlink (realpath), không chỉ so chuỗi: 'build -> /' là cách vòng qua kiểm tra
 * chuỗi quen thuộc.
 */
export function validateServedDir(dir: string, webRoot: string, flag: string): void {
  if (!isAbsolute(dir) || dir.split("/").includes("..") || /[\s;{}"'$\\]/.test(dir)) {
    die(`${flag} không hợp lệ: '${dir}' (đường dẫn tuyệt đối, không '..', không khoảng trắng hay ký tự ; { } " ' $ \\)`);
  }
  const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  const lexical = resolve(dir);
  const root = resolve(webRoot);
  if (!inside(lexical, root)) die(`${flag} '${dir}' nằm NGOÀI thư mục của app (${webRoot}) — nginx chỉ được phục vụ file của chính app này.`);
  // Đã tồn tại -> so theo realpath (bắt symlink trỏ ra ngoài). Chưa có (sẽ tạo
  // sau khi build) -> so theo tổ tiên gần nhất đang tồn tại.
  let probe = lexical;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  // Tổ tiên tồn tại gần nhất đã ở TRÊN gốc app (app chưa tạo) -> trong app chưa có
  // gì, nên cũng chưa có symlink nào để đi vòng; kiểm tra chuỗi ở trên là đủ.
  if (existsSync(probe) && inside(probe, root) && !inside(realpathSync(probe), realRoot)) {
    die(`${flag} '${dir}' đi qua một symlink trỏ ra NGOÀI thư mục của app (${realpathSync(probe)}) — từ chối.`);
  }
}

/** Kiểm tra MỌI giá trị của app sắp đi vào cấu hình nginx. Gọi ngay trước khi render. */
export function assertSafeNginxInputs(app: {
  webRoot: string;
  staticRoot?: string;
  staticPrefixes?: string[];
  staticAliases?: { prefix: string; dir: string }[];
  uploadDir?: string;
  uploadPrefix?: string;
  maxBodySize?: string;
  hotlinkAllow?: string[];
}): void {
  if (app.staticRoot) validateServedDir(app.staticRoot, app.webRoot, "--static-root");
  for (const p of app.staticPrefixes ?? []) validateUrlPrefix(p, "--static-prefix");
  for (const a of app.staticAliases ?? []) {
    validateUrlPrefix(a.prefix, "--static-alias (tiền tố)");
    validateServedDir(a.dir, app.webRoot, "--static-alias (thư mục)");
  }
  if (app.uploadDir) validateServedDir(app.uploadDir, app.webRoot, "--upload-dir");
  if (app.uploadPrefix) validateUrlPrefix(app.uploadPrefix, "--upload-prefix");
  if (app.maxBodySize) validateMaxBody(app.maxBodySize);
  for (const h of app.hotlinkAllow ?? []) validateHotlinkHost(h);
}

/**
 * Lệnh install/build/start đi vào unit systemd (ExecStart) hoặc 'bash -lc'. Ký tự
 * điều khiển — nhất là xuống dòng — thì phần sau thành một DÒNG MỚI của unit:
 * 'npm start\nUser=root' là app chạy bằng root.
 */
export function validateUnitCommand(cmd: string, flag: string): void {
  if (/[\x00-\x1f\x7f]/.test(cmd)) die(`${flag} không được chứa xuống dòng hay ký tự điều khiển.`);
  if (cmd.length > 2000) die(`${flag} quá dài (tối đa 2000 ký tự).`);
}

// Thư mục hệ thống KHÔNG BAO GIỜ được mở quyền ghi cho app qua --write-dir: mở
// là gỡ bỏ chính lớp sandbox (ProtectSystem=strict) đang bảo vệ máy khỏi app.
const PROTECTED_WRITE_DIRS = ["/", "/etc", "/usr", "/boot", "/root", "/var", "/home", "/proc", "/sys", "/dev", "/run", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/srv", "/var/lib", "/var/log", "/var/www"];

export function validateWriteDir(p: string): void {
  const real = existsSync(p) ? realpathSync(p) : p;
  for (const cand of [p, real]) {
    if (PROTECTED_WRITE_DIRS.includes(cand) || cand === "/etc/napp" || cand.startsWith("/etc/") || cand.startsWith("/usr/") || cand.startsWith("/boot/") || cand.startsWith("/root/")) {
      die(`--write-dir '${p}'${real !== p ? ` (thật ra là ${real})` : ""} là thư mục hệ thống — mở quyền ghi ở đó là gỡ bỏ sandbox bảo vệ máy khỏi app. Hãy dùng một thư mục con riêng cho dữ liệu của app.`);
    }
  }
}

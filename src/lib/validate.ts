import { die } from "./log";

const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function validateDomain(d: string): void {
  if (!DOMAIN_RE.test(d)) {
    die(`Tên miền không hợp lệ: '${d}' (ví dụ hợp lệ: api.example.com)`);
  }
  if (d.length > 253) die(`Tên miền quá dài: ${d}`);
}

export function validatePort(p: number): void {
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    die(`Cổng không hợp lệ: ${p} (phải trong khoảng 1-65535)`);
  }
}

// Chỉ chấp nhận URL git an toàn — chặn transport thực thi lệnh (ext::, fd::),
// file://, chuỗi bắt đầu bằng '-' (argument injection), khoảng trắng/ký tự
// điều khiển. Cùng logic bảo mật với validate_repo_url() trong lara.sh.
export function validateRepoUrl(url: string): void {
  if (!url) die("URL git rỗng.");
  if (url.startsWith("-")) die(`URL git không được bắt đầu bằng '-': ${url}`);
  if (/[\s\x00-\x1f]/.test(url)) {
    die("URL git chứa khoảng trắng/ký tự điều khiển không hợp lệ.");
  }
  if (/^(ext|fd)::/.test(url) || url.startsWith("file://")) {
    die(`Transport git bị cấm vì lý do bảo mật: ${url}`);
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

export function validateDbName(name: string): void {
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(name)) {
    die(`Tên database không hợp lệ: '${name}' (chỉ chữ, số, gạch dưới, tối đa 64 ký tự)`);
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

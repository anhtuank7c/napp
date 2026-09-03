import { NGINX_SCANNER_LOG } from "./nginx";

export const FAIL2BAN_JAIL_PATH = "/etc/fail2ban/jail.local";
export const FAIL2BAN_NAPP_FILTER_PATH = "/etc/fail2ban/filter.d/napp-ratelimit.conf";
export const FAIL2BAN_SCANNER_FILTER_PATH = "/etc/fail2ban/filter.d/napp-scanner.conf";

// Các jail đọc FILE log (nginx) phải ghi đè backend.
//
// [DEFAULT] đặt 'backend = systemd' cho sshd — đúng, vì trên Ubuntu sshd ghi vào
// journal. Nhưng backend đó áp cho MỌI jail, và với backend systemd thì fail2ban
// BỎ QUA 'logpath' và đi đọc journal. Nginx ghi access log ra FILE, không ra
// journal — nên mọi jail nginx trỏ vào '/var/log/nginx/*.log' đều không thấy gì
// để đọc: jail vẫn 'enabled', 'fail2ban-client status' vẫn xanh, và số IP bị ban
// đứng yên ở 0 mãi mãi. Không có lỗi nào được in ra để lần.
const FILE_BACKEND = "backend  = auto";

export function renderJailLocal(sshPort: number): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp fail2ban setup\`.
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 3
backend  = systemd
banaction = ufw

[sshd]
enabled  = true
port     = ${sshPort}
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 86400

[nginx-botsearch]
enabled  = true
${FILE_BACKEND}
port     = http,https
filter   = nginx-botsearch
logpath  = /var/log/nginx/*access.log
maxretry = 2

[nginx-http-auth]
enabled  = true
${FILE_BACKEND}
port     = http,https
filter   = nginx-http-auth
logpath  = /var/log/nginx/*error.log
maxretry = 3

[nginx-limit-req]
enabled  = true
${FILE_BACKEND}
port     = http,https
filter   = nginx-limit-req
logpath  = /var/log/nginx/*error.log
maxretry = 5

# Jail riêng cho các app Node quản lý bởi napp: chặn IP spam lỗi 502/504/429
# (thường là backend app bị treo/quá tải hoặc bị dò brute-force API).
[napp-ratelimit]
enabled  = true
${FILE_BACKEND}
port     = http,https
filter   = napp-ratelimit
logpath  = /var/log/nginx/*access.log
maxretry = 30
findtime = 60
bantime  = 1800

# Quét lỗ hổng CMS/framework PHP (/wp-login.php, /phpmyadmin/, /cgi-bin/...).
#
# Jail này chặt hơn hẳn các jail trên, và ĐƯỢC PHÉP chặt, vì nó đọc một file log
# RIÊNG chỉ chứa những request nginx ĐÃ chặn bằng 444: mọi dòng trong đó chắc
# chắn là scanner, không có traffic thật nào lẫn vào để mà ban nhầm.
#
# Đây mới là chỗ tiết kiệm tài nguyên THẬT. 'return 444' chỉ bỏ được vòng qua
# Node — phần đắt nhất của một request quét là bắt tay TCP + TLS, và nginx đã trả
# xong khoản đó trước khi kịp nhìn thấy URI. Ban ở tường lửa thì gói tin bị bỏ
# TRƯỚC cả bắt tay.
#
# ⚠️ Site sau Cloudflare proxy: banaction 'ufw' ban IP THẬT của client (nhờ
# real_ip lấy từ CF-Connecting-IP), nhưng gói tin lại đến từ IP edge của
# Cloudflare nên luật ufw không bao giờ khớp — ban thành vô hiệu mà không báo
# lỗi. Với các site đó, hãy chặn ở WAF của Cloudflare; phần chặn 444 + log sạch
# ở nginx thì vẫn có tác dụng bình thường.
[napp-scanner]
enabled  = true
${FILE_BACKEND}
port     = http,https
filter   = napp-scanner
logpath  = ${NGINX_SCANNER_LOG}
maxretry = 3
findtime = 600
bantime  = 86400
`;
}

export function renderNappRatelimitFilter(): string {
  return `# Managed by napp
[Definition]
failregex = ^<HOST> .* ".*" (502|504|429) .*$
ignoreregex =
`;
}

// Định dạng dòng log (log_format napp_scan ở 00-napp-proxy.conf):
//   1.2.3.4 - vidu.com [03/Sep/2026:14:22:01 +0700] "GET /wp-login.php HTTP/1.1" 444 "curl/8.0"
//
// failregex chỉ cần khớp phần ĐẦU dòng: file log này KHÔNG chứa gì ngoài request
// đã bị chặn, nên mọi dòng đều là một lần "thất bại". Bắt thêm theo URI hay mã
// trạng thái chỉ tạo thêm chỗ để sai khi danh sách mẫu trong nginx thay đổi.
export function renderNappScannerFilter(): string {
  return `# Managed by napp
[Definition]
failregex = ^<HOST> - \\S+ \\[
ignoreregex =

[Init]
# Ngày nằm trong cặp [] sau hostname — nói rõ ra thay vì để fail2ban tự đoán,
# vì đoán trượt thì jail im lặng không ban ai cả.
datepattern = ^[^\\[]*\\[({DATE})
`;
}

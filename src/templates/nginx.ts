import type { AppRecord } from "../lib/state";

export const CLOUDFLARE_REALIP_CONF = "/etc/nginx/conf.d/cloudflare-realip.conf";
export const NGINX_TUNING_CONF = "/etc/nginx/conf.d/napp-tuning.conf";
// Tiền tố 00- để load sớm; đây là server mặc định BẮT các request không khớp domain.
export const NGINX_DEFAULT_SERVER_CONF = "/etc/nginx/conf.d/00-napp-default-server.conf";
export const NGINX_HARDENING_CONF = "/etc/nginx/conf.d/napp-hardening.conf";
// Các `map` dùng chung ở mức http cho MỌI vhost napp quản lý. `map` KHÔNG hợp lệ
// bên trong `server {}` nên phải nằm ở file conf.d riêng như thế này.
export const NGINX_PROXY_CONF = "/etc/nginx/conf.d/00-napp-proxy.conf";

// Biến $napp_connection_upgrade: chỉ gửi 'Connection: upgrade' cho request
// WebSocket THẬT SỰ. Tên có tiền tố napp_ để không đụng map $connection_upgrade
// mà người dùng có thể đã tự khai báo ở nơi khác (trùng tên -> nginx báo lỗi).
export function renderNappProxyConf(): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA, đừng sửa tay (chạy \`napp nginx sync\` để cập nhật).
# Quyết định giá trị header 'Connection' gửi lên upstream:
#   - Request WebSocket (có Upgrade: websocket) -> 'Connection: upgrade'
#   - Request HTTP thường (Upgrade rỗng)        -> Connection RỖNG
# Giá trị rỗng khiến nginx BỎ header đi và dùng keep-alive mặc định của HTTP/1.1,
# đúng thứ mà 'keepalive 32' trong khối upstream cần. Ép cứng "upgrade" cho mọi
# request (bug cũ) sẽ gửi 'Connection: upgrade' kèm 'Upgrade:' rỗng — header méo,
# đồng thời phá luôn keepalive tới upstream.
map $http_upgrade $napp_connection_upgrade {
    default upgrade;
    ''      '';
}
`;
}

// Cấu hình hardening ở mức http (áp cho toàn nginx).
export function renderNginxHardeningConf(): string {
  return `# Managed by napp — hardening nginx (chạy \`napp nginx harden\`).
# Ẩn phiên bản nginx trong header/response lỗi để đỡ lộ thông tin cho kẻ dò quét.
server_tokens off;
`;
}

export interface DefaultServerOptions {
  ipv6: boolean;
  // "reject": dùng ssl_reject_handshake (nginx >= 1.19.4) — từ chối bắt tay TLS,
  //           không cần chứng chỉ. "selfsigned": nginx cũ -> dùng cert tự ký rồi 444.
  sslMode: "reject" | "selfsigned";
  certPath?: string;
  keyPath?: string;
}

// Server MẶC ĐỊNH bắt mọi request KHÔNG khớp server_name của app nào (truy cập
// thẳng IP, Host giả mạo, bot quét cổng...). Trả 444 = đóng kết nối, không phản
// hồi gì (không lộ thông tin). Chỉ domain đã cấu hình đúng mới vào được app.
export function renderDefaultServerConf(opts: DefaultServerOptions): string {
  const v6_80 = opts.ipv6 ? "\n    listen [::]:80 default_server;" : "";
  const v6_443 = opts.ipv6 ? "\n    listen [::]:443 ssl default_server;" : "";

  const block443 =
    opts.sslMode === "reject"
      ? `server {
    listen 443 ssl default_server;${v6_443}
    server_name _;
    # Từ chối ngay ở bước bắt tay TLS nếu SNI không khớp domain thật nào.
    ssl_reject_handshake on;
}`
      : `server {
    listen 443 ssl default_server;${v6_443}
    server_name _;
    # nginx cũ chưa hỗ trợ ssl_reject_handshake — dùng cert tự ký rồi đóng 444.
    ssl_certificate ${opts.certPath};
    ssl_certificate_key ${opts.keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;
    return 444;
}`;

  return `# Managed by napp — CHẶN request không khớp domain (truy cập thẳng IP, Host lạ).
# TỰ SINH bởi \`napp nginx harden\`; gỡ bằng \`napp nginx unharden\`. ĐỪNG sửa tay.
server {
    listen 80 default_server;${v6_80}
    server_name _;
    return 444;
}

${block443}
`;
}

// Snippet dùng chung cho MỌI site được napp quản lý: khôi phục IP client
// thật khi traffic đi qua Cloudflare proxy. Không có snippet này thì
// $remote_addr trong nginx (và req.ip ở tầng Node phía sau) sẽ luôn là IP
// của Cloudflare edge, không phải IP người dùng thật.
export function renderCloudflareRealIpSnippet(ipv4: string[], ipv6: string[]): string {
  const lines: string[] = [
    "# Managed by napp — TỰ ĐỘNG SINH RA, đừng sửa tay (chạy `napp cloudflare sync` để cập nhật).",
    "# Khôi phục IP client thật khi request đi qua Cloudflare proxy.",
    "# Nếu server KHÔNG dùng Cloudflare proxy cho một site nào đó, đơn giản là",
    "# request sẽ không đến từ các dải IP này nên $remote_addr giữ nguyên IP gốc.",
    "",
  ];
  for (const ip of ipv4) lines.push(`set_real_ip_from ${ip};`);
  for (const ip of ipv6) lines.push(`set_real_ip_from ${ip};`);
  lines.push("");
  lines.push("real_ip_header CF-Connecting-IP;");
  lines.push("real_ip_recursive on;");
  lines.push("");
  return lines.join("\n");
}

export interface NginxAppOptions {
  sslCertPath?: string; // được certbot tự điền sau khi issue — không dùng ở bước tạo ban đầu
  sslKeyPath?: string;
  extraServerNames?: string[];
  clientMaxBodySize?: string;
  ipv6?: boolean; // mặc định true; đặt false trên máy không có ngăn xếp IPv6
}

// Vhost reverse-proxy CHỈ HTTP (giống lara.sh: certbot sẽ tự sửa file này để
// thêm khối SSL khi 'napp cert issue' chạy `certbot --nginx`).
export function renderAppNginxConf(app: AppRecord, opts: NginxAppOptions = {}): string {
  const allNames = [app.domain, `www.${app.domain}`, ...app.aliasDomains, ...(opts.extraServerNames ?? [])];
  const serverNames = Array.from(new Set(allNames)).join(" ");
  const maxBody = opts.clientMaxBodySize ?? "20M";
  const ipv6Line = opts.ipv6 === false ? "" : "\n    listen [::]:80;";

  return `# Managed by napp — site: ${app.domain}
# Chỉ HTTP. Chạy 'napp cert issue ${app.domain}' để thêm HTTPS (certbot tự sửa file này).
upstream napp_${sanitizeUpstreamName(app.domain)} {
    server 127.0.0.1:${app.port};
    keepalive 32;
}

server {
    listen 80;${ipv6Line}
    server_name ${serverNames};

    access_log /var/log/nginx/${app.domain}.access.log;
    error_log  /var/log/nginx/${app.domain}.error.log;

    client_max_body_size ${maxBody};

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    location /health {
        proxy_pass http://napp_${sanitizeUpstreamName(app.domain)};
        access_log off;
    }

    location / {
        proxy_pass http://napp_${sanitizeUpstreamName(app.domain)};
        proxy_http_version 1.1;

        # WebSocket — chỉ nâng cấp khi client THẬT SỰ xin nâng cấp.
        # $napp_connection_upgrade định nghĩa ở /etc/nginx/conf.d/00-napp-proxy.conf.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $napp_connection_upgrade;

        # IP/host thật của client — nhờ napp_cloudflare_realip.conf, $remote_addr
        # ở đây ĐÃ LÀ IP thật của client (không phải IP Cloudflare edge) khi
        # request đi qua Cloudflare proxy; nếu không qua Cloudflare thì vẫn
        # đúng là IP kết nối trực tiếp.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header CF-Ray $http_cf_ray;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        proxy_buffering on;
        proxy_buffer_size 8k;
        proxy_buffers 8 8k;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}
`;
}

function sanitizeUpstreamName(domain: string): string {
  return domain.replace(/[^a-zA-Z0-9]/g, "_");
}

// Tuning nginx theo phần cứng thực tế — worker_processes/connections co giãn
// theo số lõi CPU. Ghi vào /etc/nginx/conf.d/napp-tuning.conf; worker_processes
// nằm ở khối `main` nên còn cần patch nginx.conf riêng (xem tune.ts).
export function renderNginxTuningConf(cpuCores: number, tier: string): string {
  const workerConnections = tier === "micro" ? 1024 : tier === "small" ? 2048 : 4096;
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\` (phần cứng: ${cpuCores} lõi, tier ${tier}).
keepalive_timeout 65;
keepalive_requests 1000;
client_body_timeout 12;
client_header_timeout 12;
send_timeout 10;

gzip_vary on;
# 'gzip on;' KHÔNG khai báo lại ở đây vì nginx.conf mặc định trên Ubuntu đã
# bật sẵn — khai báo lại sẽ gây lỗi "gzip directive is duplicate". Nếu server
# của bạn đã tắt gzip trong nginx.conf, hãy bật lại ở đó.
gzip_comp_level 5;
gzip_min_length 256;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

open_file_cache max=10000 inactive=60s;
open_file_cache_valid 80s;
open_file_cache_min_uses 2;
open_file_cache_errors on;
`;
}

export function nginxWorkerDirectives(cpuCores: number, tier: string): { workerProcesses: string; workerConnections: number } {
  const workerConnections = tier === "micro" ? 1024 : tier === "small" ? 2048 : 4096;
  return { workerProcesses: "auto", workerConnections };
}

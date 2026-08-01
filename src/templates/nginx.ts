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
  // Thư mục chứa asset đã build, để NGINX trả file thẳng từ đĩa thay vì bắt
  // tiến trình Node làm việc đó. Ví dụ SvelteKit: <webRoot>/build/client.
  staticRoot?: string;
  // Các tiền tố URL được phục vụ từ staticRoot. Chỉ nên là những đường dẫn mà
  // framework sinh ra với tên có băm nội dung — chúng không bao giờ trùng route
  // của ứng dụng. SvelteKit: /_app/ · Next.js: /_next/static/ · Vite: /assets/
  staticPrefixes?: string[];
  // Thư mục file NGƯỜI DÙNG TẢI LÊN lúc chạy. KHÁC HẲN staticRoot: staticRoot là
  // kết quả build (bất biến giữa hai lần deploy), còn thư mục này thay đổi liên
  // tục trong lúc chạy và KHÔNG được build sinh ra.
  uploadDir?: string;
  // Tiền tố URL của thư mục trên. Mặc định "/uploads/".
  uploadPrefix?: string;
  // Chặn hotlink: chỉ cho nhúng ảnh từ chính domain của site.
  hotlinkProtect?: boolean;
  // Domain NGOÀI cũng được phép nhúng (đối tác, CDN, trang xem trước...).
  hotlinkAllow?: string[];
}

// Vhost reverse-proxy CHỈ HTTP (giống lara.sh: certbot sẽ tự sửa file này để
// thêm khối SSL khi 'napp cert issue' chạy `certbot --nginx`).
export function renderAppNginxConf(app: AppRecord, opts: NginxAppOptions = {}): string {
  const allNames = [app.domain, `www.${app.domain}`, ...app.aliasDomains, ...(opts.extraServerNames ?? [])];
  const serverNames = Array.from(new Set(allNames)).join(" ");
  // Đọc từ AppRecord trước, opts chỉ để ghi đè. Trước đây các giá trị này CHỈ
  // đến từ opts, mà cả hai chỗ gọi (`app create` và `domain`) đều không truyền
  // — nên client_max_body_size luôn rơi về 20M dù người dùng có cấu hình gì đi
  // nữa, và upload lớn hơn thế bị nginx chặn bằng 413 trước khi tới app. Lấy
  // nguồn sự thật là bản ghi thì thêm một chỗ gọi mới cũng không thể quên.
  const maxBody = opts.clientMaxBodySize ?? app.maxBodySize ?? "20M";
  const staticRoot = opts.staticRoot ?? app.staticRoot;
  const staticPrefixes = opts.staticPrefixes ?? app.staticPrefixes;
  const uploadDir = opts.uploadDir ?? app.uploadDir;
  const uploadPrefix = opts.uploadPrefix ?? app.uploadPrefix ?? "/uploads/";
  const hotlinkProtect = opts.hotlinkProtect ?? app.hotlinkProtect ?? false;
  const hotlinkAllow = opts.hotlinkAllow ?? app.hotlinkAllow;
  const ipv6Line = opts.ipv6 === false ? "" : "\n    listen [::]:80;";

  // --- asset tĩnh (tuỳ chọn) ------------------------------------------------
  // Không có staticRoot thì MỌI request — kể cả từng file .js/.css/.woff2 — đều
  // đi qua tiến trình Node. Một trang của app SPA/SSR hiện đại kéo hàng trăm
  // chunk, tất cả xếp hàng trên event loop đơn luồng và tranh chấp với chính
  // việc render trang. Đó là nguyên nhân phổ biến nhất của hiện tượng "vào
  // dashboard thấy giựt" dù server đo ra vẫn nhanh.
  //
  // CỐ Ý chỉ phục vụ theo TIỀN TỐ đã khai báo, không dùng `try_files $uri` chung
  // cho location /: một try_files chung sẽ đem cả cây thư mục ra đường (kể cả
  // file lọt vào đó ngoài ý muốn) và có thể trả index.html tĩnh thay vì để app
  // tự render. Tiền tố có tên băm nội dung thì không bao giờ đụng route của app.
  const staticBlock =
    staticRoot && (staticPrefixes?.length ?? 0) > 0
      ? `
    root ${staticRoot};
${staticPrefixes!
  .map(
    (p) => `
    location ^~ ${p} {
        try_files $uri =404;
        # Ba header bảo mật dưới đây được LẶP LẠI có chủ đích: chỉ cần một
        # 'add_header' trong location con là nginx BỎ TOÀN BỘ add_header kế thừa
        # từ khối server. Không lặp lại thì riêng các file tĩnh sẽ mất
        # 'nosniff' — đúng loại phản hồi cần nó nhất, vì trình duyệt đoán sai
        # kiểu nội dung của một file .js là một vector tấn công thật sự.
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        # Một 'Cache-Control' duy nhất. KHÔNG dùng kèm 'expires' — expires cũng
        # sinh ra Cache-Control, và hai chỉ thị cùng lúc trả về HAI header.
        # 'immutable' mới là phần đáng giá: nó bỏ luôn bước revalidate khi người
        # dùng bấm tải lại, thứ mà 'expires' một mình không làm được.
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }`
  )
  .join("")}
`
      : "";

  // --- file người dùng tải lên (tuỳ chọn) -----------------------------------
  // Đây là một cái bẫy riêng, KHÔNG dùng staticRoot giải quyết được.
  //
  // Với SvelteKit adapter-node (và các framework tương tự), thư mục `static/`
  // được SAO CHÉP vào `build/client/` LÚC BUILD, và lúc chạy server chỉ phục vụ
  // `build/client`. Nên một file tải lên sau khi build — nằm ở `static/uploads`
  // — KHÔNG có trong build/client và server trả 404, dù file có thật trên đĩa.
  //
  // Triệu chứng rất dễ đọc nhầm: ảnh admin vừa tải lên bị vỡ, rồi tự nhiên hiện
  // ra sau lần deploy kế tiếp (vì build lại sao chép static/), nên nó giống lỗi
  // chập chờn hoặc lỗi cache hơn là lỗi cấu hình. Đo trên một bản build thật:
  // file có sẵn lúc build -> 200; file tải lên sau đó -> 404.
  //
  // Dùng `alias` (không kèm try_files): với alias thì try_files có hành vi khác
  // nhau giữa các bản nginx; bỏ đi thì nginx vẫn trả 404 đúng khi thiếu file.
  // --- chặn hotlink (tuỳ chọn) ----------------------------------------------
  // 'none' và 'blocked' ĐƯỢC PHÉP, và đó là phần dễ làm sai nhất:
  //
  //   none    = request KHÔNG có header Referer. Bao gồm: gõ thẳng URL ảnh,
  //             trình duyệt/tiện ích cắt Referer vì quyền riêng tư, và QUAN
  //             TRỌNG NHẤT là các trình thu thập ảnh xem trước khi chia sẻ link
  //             (Facebook, Zalo, Telegram, Slack...) — chúng thường không gửi
  //             Referer. Chặn 'none' nghĩa là mọi link chia sẻ mất ảnh preview,
  //             một thiệt hại lớn hơn nhiều so với hotlink mà nó ngăn được.
  //   blocked = có Referer nhưng bị proxy/tường lửa doanh nghiệp xoá nội dung.
  //             Chặn nhóm này là chặn nhầm người dùng thật sau proxy công ty.
  //
  // 'server_names' tự khớp với server_name của chính vhost này, nên thêm domain
  // phụ vào site là tự động được phép, không phải sửa hai nơi.
  //
  // GIỚI HẠN, cần biết trước khi tin vào nó:
  //  1. Referer do TRÌNH DUYỆT tự khai. Trang hotlink chỉ cần đặt
  //     <meta name="referrer" content="no-referrer"> là rơi vào nhóm 'none' và
  //     đi qua. Đây là biện pháp chặn hotlink TUỲ TIỆN, không phải kiểm soát
  //     truy cập — đừng dùng nó để bảo vệ ảnh riêng tư.
  //  2. Nếu có CDN đứng trước (Cloudflare...), CDN cache theo URL và KHÔNG quan
  //     tâm Referer: ảnh đã vào cache edge sẽ được CDN trả cho mọi referer mà
  //     không hỏi origin. Cấu hình này khi đó chỉ tác dụng với lần cache MISS.
  //     Muốn chặn thật thì bật ở tầng CDN. KHÔNG thêm 'Vary: Referer' để chữa —
  //     nó biến mỗi referer thành một bản cache riêng và phá nát hiệu quả cache.
  const hotlinkBlock = hotlinkProtect
    ? `
        # Chỉ cho nhúng từ chính domain này. Xem chú thích ở nginx.ts về vì sao
        # 'none' và 'blocked' được phép, và vì sao đây không phải kiểm soát truy cập.
        valid_referers none blocked server_names${
          (hotlinkAllow?.length ?? 0) > 0 ? " " + hotlinkAllow!.join(" ") : ""
        };
        if ($invalid_referer) { return 403; }
`
    : "";

  const uploadBlock = uploadDir
    ? `
    location ^~ ${uploadPrefix} {
        alias ${uploadDir.replace(/\/+$/, "")}/;
${hotlinkBlock}
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        # Ngắn hơn asset build rất nhiều: tên file tải lên KHÔNG băm nội dung,
        # nên cùng một URL có thể đổi nội dung. 'immutable' ở đây sẽ khoá bản cũ
        # trong cache trình duyệt hàng năm trời.
        add_header Cache-Control "public, max-age=86400" always;
        access_log off;
    }
`
    : "";

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
${staticBlock}${uploadBlock}
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
        # 8k x 8 = 64 KB là đủ cho API trả JSON nhỏ, nhưng KHÔNG đủ cho một
        # trang SSR: phần vượt quá bộ đệm bị nginx ghi ra FILE TẠM trên đĩa rồi
        # đọc lại, mỗi request một lần. Một trang admin 300 KB nghĩa là ~240 KB
        # ghi/đọc đĩa cho mỗi lượt xem. 16k header + 16 x 16k = 256 KB thân
        # trang giữ trọn phần lớn trang SSR trong RAM; bộ đệm chỉ được cấp khi
        # request đang chạy nên chi phí bộ nhớ là theo tải thực tế.
        proxy_buffer_size 16k;
        proxy_buffers 16 16k;
        proxy_busy_buffers_size 32k;
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
#
# gzip_proxied quyết định có nén hay không khi REQUEST CỦA CLIENT mang header
# 'Via' — nginx lấy sự hiện diện của Via làm dấu hiệu "request này đã đi qua một
# proxy". Đây KHÔNG phải là "phản hồi đến từ upstream": không có Via thì nginx
# nén bình thường bất kể có proxy_pass hay không. Mặc định là 'off', và trên
# Ubuntu dòng này bị comment sẵn trong nginx.conf.
#
# Đo thực tế với một trang 132 KB, client gửi 'Accept-Encoding: gzip':
#   không Via  -> nén trong cả hai trường hợp
#   có Via     -> KHÔNG có dòng này: trả nguyên 132 KB · có dòng này: nén
#
# Cloudflare không gửi Via nên site sau Cloudflare thường không dính. Nhưng
# Fastly, Varnish, squid và phần lớn proxy doanh nghiệp thì CÓ — và khi dính thì
# triệu chứng là "chậm với một số người dùng", gần như không thể lần ra.
gzip_proxied any;
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

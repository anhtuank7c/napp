import type { AppRecord } from "../lib/state";

export const CLOUDFLARE_REALIP_CONF = "/etc/nginx/conf.d/cloudflare-realip.conf";
export const NGINX_TUNING_CONF = "/etc/nginx/conf.d/napp-tuning.conf";
// Tiền tố 00- để load sớm; đây là server mặc định BẮT các request không khớp domain.
export const NGINX_DEFAULT_SERVER_CONF = "/etc/nginx/conf.d/00-napp-default-server.conf";
export const NGINX_HARDENING_CONF = "/etc/nginx/conf.d/napp-hardening.conf";
// Các `map` dùng chung ở mức http cho MỌI vhost napp quản lý. `map` KHÔNG hợp lệ
// bên trong `server {}` nên phải nằm ở file conf.d riêng như thế này.
export const NGINX_PROXY_CONF = "/etc/nginx/conf.d/00-napp-proxy.conf";

// Các `location` riêng của từng app (asset build, file tải lên, chặn hotlink)
// nằm ở file RIÊNG, được vhost `include` vào bằng ĐÚNG MỘT dòng.
//
// Vì sao không viết thẳng vào vhost: certbot chèn khối SSL vào chính file vhost
// khi cấp chứng chỉ, nên render lại vhost là XOÁ HTTPS của site đang chạy. Tách
// ra file riêng thì đổi cấu hình về sau chỉ là ghi đè MỘT file mà napp sở hữu
// trọn vẹn — không cần chạm vào vhost lần nào nữa, không có gì của certbot để
// làm hỏng. Đây cũng là lý do `napp nginx sync` chỉ dám vá bằng thay chuỗi.
export const NGINX_LOCATIONS_DIR = "/etc/nginx/napp-locations";

export function appLocationsPath(domain: string): string {
  return `${NGINX_LOCATIONS_DIR}/${domain}.conf`;
}

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

${PROXY_BUFFER_BLOCK}`;
}

// Bộ đệm proxy — dùng CHUNG cho mọi vhost napp (đặt ở mức http, vhost nào có
// khối riêng thì khối đó thắng).
//
// proxy_buffer_size là bộ đệm chứa TOÀN BỘ KHỐI HEADER của response. Vượt quá
// là nginx đóng kết nối và trả 502, ghi log 'upstream sent too big header while
// reading response header from upstream' — trang trắng, còn app phía sau thì
// hoàn toàn khoẻ mạnh nên rất dễ đổ lỗi nhầm cho Node.
//
// SvelteKit đụng trần này ở các route SÂU: mỗi tầng layout/page góp thêm các
// mục 'Link: </_app/immutable/...>; rel=modulepreload' vào header, tên file lại
// có hash dài. Route càng lồng nhiều tầng thì khối header càng phình — cùng một
// app, trang chủ chạy tốt còn '/admin/hotels/1/rooms/2/edit' thì 502. Cộng thêm
// Set-Cookie phiên đăng nhập là chạm 16k dễ như không.
//
// 128k header + 4 x 256k thân là giá trị đã kiểm chứng trên máy thật. Bộ đệm
// CHỈ được cấp khi có request đang chạy (không phải cấp phát trước), nên chi phí
// bộ nhớ đi theo tải thực tế chứ không phải theo số vhost.
const PROXY_BUFFER_BLOCK = `proxy_buffering on;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
`;

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
  // KHÔNG có staticRoot/uploadDir/hotlink* ở đây: chúng nằm trên AppRecord và
  // được `renderAppLocationsConf` dựng thành file include riêng. Để lại bản sao
  // ở đây là dựng lại đúng cái bẫy vừa sửa cho clientMaxBodySize — một tham số
  // trông như có tác dụng nhưng không chỗ gọi nào đọc.
}


/**
 * Các `location` riêng của một app, để vhost `include` vào.
 *
 * Tách khỏi `renderAppNginxConf` để `app create` và `app set` dùng CHUNG một
 * nguồn: nếu mỗi bên tự dựng lấy thì cấu hình của app tạo mới và app sửa sau sẽ
 * trôi khỏi nhau mà không ai phát hiện.
 *
 * Trả về chuỗi RỖNG khi app không bật tuỳ chọn nào — file vẫn được ghi (rỗng),
 * vì `include` trỏ vào file không tồn tại làm nginx từ chối khởi động.
 */
export function renderAppLocationsConf(app: AppRecord): string {
  const staticRoot = app.staticRoot;
  const staticPrefixes = app.staticPrefixes;
  const uploadDir = app.uploadDir;
  const uploadPrefix = app.uploadPrefix ?? "/uploads/";
  const hotlinkProtect = app.hotlinkProtect ?? false;
  const hotlinkAllow = app.hotlinkAllow;
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

  // --- asset tĩnh phục vụ bằng `alias` (tuỳ chọn) ---------------------------
  // Dùng khi ĐOẠN URL và TÊN THƯ MỤC TRÊN ĐĨA KHÁC NHAU, nên `root` không ghép
  // ra đúng đường dẫn. Ca kinh điển là Next.js: asset nằm ở '.next/static/…'
  // nhưng URL là '/_next/static/…'. `root .next` sẽ nối nguyên URI vào sau root
  // và đi tìm '.next/_next/static/…' — đường dẫn không bao giờ tồn tại, nên
  // TOÀN BỘ JS/CSS trả 404 và trang trắng. `alias` thì THAY THẾ phần tiền tố đã
  // khớp bằng thư mục, ra đúng '.next/static/…'.
  //
  // KHÔNG kèm `try_files` — cùng lý do đã ghi ở khối upload bên dưới: hành vi
  // của try_files trong location dùng alias khác nhau giữa các bản nginx, mà bỏ
  // đi thì nginx vẫn trả 404 đúng khi thiếu file.
  const aliasBlock = (app.staticAliases ?? [])
    .map(
      (a) => `
    location ^~ ${a.prefix} {
        alias ${a.dir.replace(/\/+$/, "")}/;
        # Lặp lại ba header bảo mật vì cùng lý do như khối trên: một add_header
        # trong location con là nginx bỏ toàn bộ add_header kế thừa từ server.
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }
`
    )
    .join("");

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


  const out = `${staticBlock}${aliasBlock}${uploadBlock}`;
  return out.trim().length === 0
    ? `# Managed by napp — site: ${app.domain}\n# Chưa bật tuỳ chọn nào (--static-root / --static-alias / --upload-dir). File giữ lại vì vhost include nó.\n`
    : `# Managed by napp — location riêng của ${app.domain}. TỰ SINH, đừng sửa tay.\n# Cập nhật bằng: napp app set ${app.domain} ...\n${out}`;
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

    # Location riêng của app (asset build / file tải lên / chặn hotlink).
    # Nằm ở file riêng để đổi cấu hình về sau KHÔNG phải render lại vhost này —
    # certbot chèn khối SSL vào đây, render lại là mất HTTPS. Sửa bằng:
    #   napp app set ${app.domain} --static-root ... --upload-dir ...
    include ${appLocationsPath(app.domain)};
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

        # Bộ đệm proxy KHÔNG đặt ở đây nữa: nó nằm ở mức http trong
        # /etc/nginx/conf.d/00-napp-proxy.conf và được kế thừa xuống. Đặt lại
        # trong từng vhost nghĩa là mỗi lần đổi giá trị phải sửa lại vhost —
        # mà vhost là chỗ certbot chèn khối SSL vào, render lại là mất HTTPS.
        # Muốn riêng cho site này thì thêm proxy_buffer_size/proxy_buffers vào
        # đây, giá trị trong location luôn thắng giá trị ở mức http.
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

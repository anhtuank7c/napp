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
// làm hỏng. Đây cũng là lý do `napp nginx apply` chỉ dám vá bằng thay chuỗi.
export const NGINX_LOCATIONS_DIR = "/etc/nginx/napp-locations";

export function appLocationsPath(domain: string): string {
  return `${NGINX_LOCATIONS_DIR}/${domain}.conf`;
}

// File location do NGƯỜI DÙNG viết. napp include nó vào cuối file tự sinh và
// KHÔNG BAO GIỜ ghi đè — xem lib/locationsfile.ts về lý do nó phải tồn tại.
export function appCustomLocationsPath(domain: string): string {
  return `${NGINX_LOCATIONS_DIR}/${domain}.custom.conf`;
}

// Chặn quét lỗ hổng — file DÙNG CHUNG cho MỌI site, không phải mỗi site một bản.
// Danh sách mẫu là thứ sẽ còn phải sửa nhiều lần (scanner đổi mẫu liên tục);
// nhân nó ra N file là N chỗ phải sửa và N cơ hội để chúng trôi khỏi nhau.
// Tên bắt đầu bằng '_' để không bao giờ đụng tên một domain thật.
export const NGINX_SCANNER_BLOCK_CONF = `${NGINX_LOCATIONS_DIR}/_scanner-block.conf`;
// Access log RIÊNG cho request bị chặn — xem chú thích ở renderScannerBlockConf
// về vì sao KHÔNG dùng 'access_log off'.
export const NGINX_SCANNER_LOG = "/var/log/nginx/napp-scanner.log";
// Tên log_format khai báo ở mức http trong 00-napp-proxy.conf.
export const NGINX_SCANNER_LOG_FORMAT = "napp_scan";

// Biến $napp_connection_upgrade: chỉ gửi 'Connection: upgrade' cho request
// WebSocket THẬT SỰ. Tên có tiền tố napp_ để không đụng map $connection_upgrade
// mà người dùng có thể đã tự khai báo ở nơi khác (trùng tên -> nginx báo lỗi).
export function renderNappProxyConf(): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA, đừng sửa tay (chạy \`napp nginx apply\` để cập nhật).
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

# Định dạng log cho request quét lỗ hổng bị chặn (xem _scanner-block.conf).
# PHẢI khai báo ở mức http như ở đây: 'log_format' không hợp lệ trong server{}.
# Có thêm $host so với 'combined' vì file log là DÙNG CHUNG cho mọi site — thiếu
# cột đó thì biết có kẻ đang quét mà không biết nó quét site nào.
log_format ${NGINX_SCANNER_LOG_FORMAT} '$remote_addr - $host [$time_local] "$request" $status "$http_user_agent"';

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
  return `# Managed by napp — hardening nginx (chạy \`napp nginx hardening enable\`).
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
# TỰ SINH bởi \`napp nginx hardening enable\`; gỡ bằng \`napp nginx hardening disable\`. ĐỪNG sửa tay.
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
    "# Managed by napp — TỰ ĐỘNG SINH RA, đừng sửa tay (chạy `napp cloudflare apply` để cập nhật).",
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


// Mẫu URI của các đợt quét lỗ hổng CMS/framework PHP.
//
// NEO VÀO ĐUÔI FILE VÀ NAMESPACE RIÊNG, KHÔNG ĐOÁN THEO ĐƯỜNG DẪN CHUNG CHUNG.
// Chế độ hỏng duy nhất đáng sợ ở đây là chặn nhầm route THẬT của app, và nó hỏng
// im lặng: người dùng thấy trang trắng / kết nối bị ngắt, còn log của site thì
// sạch bong vì request đã bị chuyển sang file log khác. Vì thế danh sách này
// KHÔNG có '/admin', '/config', '/vendor', '/backup', '/telescope', '/horizon'
// — tất cả đều là route hoàn toàn hợp lệ của một app Node. Đuôi '.php'/'.asp'/
// '.jsp' thì không: một app Node không phục vụ chúng, không bao giờ.
//
// Neo theo đuôi cũng đã bắt luôn phần lớn mẫu Laravel/PHP mà KHÔNG cần thêm luật
// đường dẫn: '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php' kết thúc bằng
// '.php'. Thêm một luật '^/vendor/' chỉ làm tăng rủi ro chặn nhầm mà không bắt
// thêm được gì.
//
// CỐ Ý KHÔNG có luật cho '.env' hay '/.git/': vhost napp đã có sẵn
// 'location ~ /\.(?!well-known).* { deny all; }'. Thêm luật thứ hai ở đây thì
// kết quả phụ thuộc vào luật nào được KHAI BÁO TRƯỚC (nginx chọn location regex
// theo THỨ TỰ KHAI BÁO) — mà vị trí dòng include lại khác nhau giữa vhost tạo
// mới (include nằm trước) và vhost cũ được vá bằng `napp nginx apply` (include
// chèn ở cuối khối server). Một luật đổi hành vi theo TUỔI của vhost là thứ
// không ai lần ra nổi về sau.
//
// Dùng `~*` (không phân biệt hoa thường) vì scanner có gửi cả '/WP-ADMIN/'.
const SCANNER_PATTERNS: { re: string; why: string }[] = [
  {
    re: String.raw`\.(php[0-9]?|phtml|phps|asp|aspx|jsp|jspx|cfm|cgi|shtml)$`,
    why: "đuôi file của runtime mà app Node KHÔNG BAO GIỜ phục vụ",
  },
  {
    re: String.raw`^/(wp-admin|wp-content|wp-includes|wp-json|wordpress)/`,
    why: "namespace riêng của WordPress",
  },
  {
    re: String.raw`^/(phpmyadmin|phpmyadmin[0-9._-]*|pma|myadmin|mysqladmin|adminer|dbadmin)(/|$)`,
    why: "trang quản trị database viết bằng PHP",
  },
  { re: String.raw`^/cgi-bin/`, why: "CGI cổ điển (Shellshock và họ hàng)" },
];

/**
 * File chặn quét lỗ hổng, DÙNG CHUNG cho mọi site napp quản lý.
 *
 * BỐI CẢNH — một máy chủ Node công khai nhận hàng nghìn request/ngày dò các CMS
 * PHP: '/wp-login.php', '/wp-admin/setup-config.php', '/phpmyadmin/', các mẫu
 * eval-stdin của Laravel/phpunit... Không cái nào HẠI được app Node (không có
 * PHP nào để chạy), nhưng mỗi cái đều đi trọn đường nginx -> proxy_pass -> router
 * của framework -> render trang 404. Với SSR (SvelteKit/Next) đó là cả chuỗi
 * hook/layout chạy để dựng một trang lỗi cho một con bot. Và tất cả đều rơi vào
 * access log của site, trộn lẫn với traffic thật.
 *
 * ĐỪNG KỲ VỌNG SAI VÀO CON SỐ: `return 444` KHÔNG tiết kiệm nhiều CPU như tên
 * gọi gợi ý. Phần đắt nhất của một request quét là bắt tay TCP + TLS, và nginx
 * đã trả xong khoản đó TRƯỚC khi kịp nhìn thấy URI. Thứ tiết kiệm được là vòng
 * qua Node, không phải cái bắt tay. Khoản lời THẬT nằm ở hai chỗ khác: access
 * log của site sạch trở lại, và fail2ban có một tín hiệu ban gần như hoàn hảo.
 *
 * VÌ SAO KHÔNG `access_log off` — đây là chỗ dễ làm hỏng nhất:
 * Cách hiển nhiên để hết ồn log là tắt log cho các location này. Làm vậy là mất
 * luôn jail `nginx-botsearch` của fail2ban — nó đọc '/var/log/nginx/*access.log'.
 * Kết quả: log sạch NHƯNG scanner không bao giờ bị ban, cứ mở kết nối mãi, tức
 * là đổi một khoản lỗ nhỏ lấy một khoản lỗ to hơn.
 *
 * Nên: ghi sang MỘT FILE RIÊNG. Access log của site sạch bong, còn file riêng đó
 * là tín hiệu hoàn hảo — MỌI dòng trong nó chắc chắn là scanner, nên jail
 * `napp-scanner` để maxretry=3 / bantime 1 ngày mà không có rủi ro ban nhầm.
 * Logrotate mặc định của Ubuntu đã xoay vòng '/var/log/nginx/*.log' nên file này
 * không cần cấu hình rotate riêng.
 *
 * LƯU Ý KHI CÓ CLOUDFLARE ĐỨNG TRƯỚC: 444 = đóng kết nối không phản hồi, và
 * Cloudflare dịch điều đó thành trang lỗi 520 cho người xem. Với scanner thì
 * không sao, nhưng nếu một luật ở đây chặn nhầm route thật thì người dùng thấy
 * "520" chứ không phải 404 — trông như server sập. Đó là lý do danh sách mẫu ở
 * trên hẹp đến mức gần như không thể chặn nhầm.
 *
 * @param enabled false -> file rỗng (chỉ chú thích). KHÔNG xoá file: nó đang
 *   được include, mà include trỏ vào file không có thật thì nginx TỪ CHỐI KHỞI
 *   ĐỘNG trên TOÀN MÁY — sập mọi site chứ không riêng site nào.
 */
export function renderScannerBlockConf(enabled: boolean): string {
  const header =
    `# Managed by napp — chặn quét lỗ hổng (CMS/framework PHP). TỰ SINH, đừng sửa tay.\n` +
    `#   Bật : napp nginx scan-block enable      Tắt: napp nginx scan-block disable\n` +
    `#   Một site cụ thể: napp app update <domain> --no-scan-block\n` +
    `# File này được MỌI vhost napp quản lý include (một dòng trong <domain>.conf).\n`;

  if (!enabled) {
    return (
      header +
      `#\n` +
      `# ĐANG TẮT. File vẫn tồn tại và vẫn được include — TẮT nghĩa là làm RỖNG,\n` +
      `# không phải xoá: include trỏ vào file không có thật khiến nginx từ chối\n` +
      `# khởi động trên TOÀN MÁY, sập mọi site chứ không riêng site nào.\n`
    );
  }

  const blocks = SCANNER_PATTERNS.map(
    (p) => `
    # ${p.why}
    location ~* ${p.re} {
        # Log sang file RIÊNG, KHÔNG tắt log — xem chú thích ở nginx.ts:
        # tắt log là fail2ban mất tín hiệu và scanner không bao giờ bị ban.
        access_log ${NGINX_SCANNER_LOG} ${NGINX_SCANNER_LOG_FORMAT};
        return 444;
    }`
  ).join("\n");

  return `${header}#
# 444 = đóng kết nối, không gửi gì cả (không lộ thông tin, không tốn băng thông).
# Request bị chặn ghi vào ${NGINX_SCANNER_LOG} — mọi dòng trong đó
# chắc chắn là scanner, nên jail 'napp-scanner' của fail2ban ban được rất chặt
# mà không sợ ban nhầm. Xem: napp fail2ban apply
${blocks}
`;
}

/**
 * Các `location` riêng của một app, để vhost `include` vào.
 *
 * Tách khỏi `renderAppNginxConf` để `app create` và `app update` dùng CHUNG một
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
  const hotlinkStrict = app.hotlinkStrict ?? false;

  // --- Cross-Origin-Resource-Policy: lớp chặn hotlink THẬT SỰ ----------------
  //
  // Khác `valid_referers` ở đúng chỗ quan trọng nhất: CORP do TRÌNH DUYỆT CỦA
  // NGƯỜI XEM thực thi, dựa trên header do SERVER CỦA BẠN gửi ra. Trang hotlink
  // không có cách nào tác động tới nó — trong khi Referer là thứ chính trang đó
  // khai báo, nên chỉ cần một thẻ <meta name="referrer" content="no-referrer">
  // là toàn bộ `valid_referers` bị vô hiệu.
  //
  // Và nó SỐNG SÓT QUA CDN. Cloudflare cache theo URL rồi trả bản cache cho mọi
  // referer mà không hỏi origin, nên kiểm tra Referer ở origin gần như vô dụng
  // khi có CDN đứng trước. CORP thì nằm trong chính response đã cache, và trình
  // duyệt vẫn thực thi nó ở phía người xem — cache hay không cache đều như nhau.
  //
  // KHÔNG phá thứ mà '--hotlink-strict' phá:
  //   - Bot lấy ảnh preview (Facebook, Zalo, Telegram) tải ảnh Ở PHÍA SERVER,
  //     không phải trình duyệt, nên CORP không áp — link chia sẻ VẪN có ảnh.
  //   - Gõ thẳng URL ảnh là ĐIỀU HƯỚNG cấp cao nhất, không phải subresource
  //     nhúng vào trang khác, nên cũng không bị chặn.
  //
  // Chọn 'same-site' chứ không 'same-origin': napp tự thêm alias 'www.<domain>',
  // và admin/api thường nằm ở subdomain khác. 'same-origin' sẽ chặn chính
  // www.<domain> nhúng ảnh của <domain> — hỏng ngay trên site của mình.
  //
  // GIỚI HẠN: CORP chỉ có ba giá trị (same-origin/same-site/cross-origin), KHÔNG
  // có danh sách cho phép theo domain. Nên khi người dùng đã khai '--hotlink-allow'
  // để cho phép domain NGOÀI nhúng, ta KHÔNG phát CORP — phát ra là chặn đúng
  // những domain vừa được cho phép, và lỗi đó im lặng (ảnh vỡ ở phía đối tác).
  // Khi đó chỉ còn `valid_referers` làm việc, và app.ts nói rõ điều này ra.
  const corpApplies = hotlinkProtect && (hotlinkAllow?.length ?? 0) === 0;
  const corpHeader = corpApplies
    ? `
        # Chặn hotlink do TRÌNH DUYỆT thực thi — trang nhúng không tác động được,
        # và nó vẫn hiệu lực sau khi đi qua cache CDN. Xem chú thích ở nginx.ts.
        add_header Cross-Origin-Resource-Policy "same-site" always;`
    : "";

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
        add_header Cache-Control "public, max-age=31536000, immutable" always;${corpHeader}
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
        add_header Cache-Control "public, max-age=31536000, immutable" always;${corpHeader}
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
  //  3. Với '--hotlink-strict', 'none' và 'blocked' BỊ BỎ khỏi danh sách. Chặt
  //     hơn thật, nhưng đổi lại đúng những thiệt hại kể trên: mất ảnh preview
  //     khi chia sẻ link, và người dùng thật sau proxy công ty bị 403.
  const referers = hotlinkStrict ? ["server_names"] : ["none", "blocked", "server_names"];
  const hotlinkBlock = hotlinkProtect
    ? `
        # Chỉ cho nhúng từ chính domain này. Xem chú thích ở nginx.ts về vì sao
        # 'none' và 'blocked' được phép${hotlinkStrict ? " (đã BỎ vì --hotlink-strict)" : ""}, và vì sao đây không phải kiểm soát truy cập.
        valid_referers ${referers.join(" ")}${(hotlinkAllow?.length ?? 0) > 0 ? " " + hotlinkAllow!.join(" ") : ""};
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
        add_header Cache-Control "public, max-age=86400" always;${corpHeader}
        access_log off;
    }
`
    : "";


  // Include file sidecar ở CUỐI, sau mọi location napp sinh ra. Thứ tự trong
  // file không quyết định location nào thắng (nginx chọn theo độ dài tiền tố,
  // không theo vị trí), nên đặt cuối chỉ để người đọc thấy rõ ranh giới giữa
  // phần tự sinh và phần của mình.
  //
  // LUÔN include, kể cả khi app chưa bật tuỳ chọn nào — file sidecar được
  // lib/locationsfile.ts tạo sẵn (rỗng) trước mỗi lần ghi, nên include không
  // bao giờ trỏ vào file không tồn tại.
  // Chặn quét lỗ hổng — MỘT dòng include trỏ vào file DÙNG CHUNG, để danh sách
  // mẫu chỉ tồn tại ở đúng một chỗ trên máy. Bỏ dòng này cho riêng một site
  // bằng 'napp app update <domain> --no-scan-block' (vd site thật sự có phục vụ
  // file .php qua một upstream khác, hoặc đang migrate từ WordPress sang).
  //
  // Đặt TRƯỚC customInclude: nginx chọn location regex theo THỨ TỰ KHAI BÁO, nên
  // luật của napp phải đứng trước luật người dùng tự viết mới thắng được.
  const scannerInclude =
    app.scanBlock === false
      ? `\n    # Chặn quét lỗ hổng: ĐÃ TẮT cho site này (napp app update ${app.domain} --scan-block để bật lại).\n`
      : `\n    # Chặn quét lỗ hổng (wp-admin, .php, phpmyadmin... -> 444, log riêng).\n` +
        `    # Danh sách mẫu dùng chung cho mọi site, sửa một chỗ: ${NGINX_SCANNER_BLOCK_CONF}\n` +
        `    include ${NGINX_SCANNER_BLOCK_CONF};\n`;

  const customInclude =
    `\n    # Location do BẠN viết. napp KHÔNG BAO GIỜ ghi đè file dưới đây — đặt\n` +
    `    # location riêng vào đó thay vì sửa file này (file này bị render lại\n` +
    `    # mỗi lần 'napp app update' / 'napp app alias create' chạy).\n` +
    `    include ${appCustomLocationsPath(app.domain)};\n`;

  const out = `${staticBlock}${aliasBlock}${uploadBlock}`;
  return out.trim().length === 0
    ? `# Managed by napp — site: ${app.domain}\n# Chưa bật tuỳ chọn nào (--static-root / --static-alias / --upload-dir). File giữ lại vì vhost include nó.\n${scannerInclude}${customInclude}`
    : `# Managed by napp — location riêng của ${app.domain}. TỰ SINH, đừng sửa tay.\n# Cập nhật bằng: napp app update ${app.domain} ...\n${out}${scannerInclude}${customInclude}`;
}

// Vhost reverse-proxy CHỈ HTTP (giống lara.sh: certbot sẽ tự sửa file này để
// thêm khối SSL khi 'napp cert create' chạy `certbot --nginx`).
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
# Chỉ HTTP. Chạy 'napp cert create ${app.domain}' để thêm HTTPS (certbot tự sửa file này).
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
    #   napp app update ${app.domain} --static-root ... --upload-dir ...
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

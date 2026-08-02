// __NAPP_VERSION__ được esbuild thay thế tại thời điểm build (define trong
// esbuild.config.mjs) bằng version trong package.json.
declare const __NAPP_VERSION__: string;

export const NAPP_VERSION: string =
  typeof __NAPP_VERSION__ !== "undefined" ? __NAPP_VERSION__ : "0.0.0-dev";

// Nguồn tự cập nhật ('napp update'): URL raw "MỚI NHẤT" của một gist CÔNG
// KHAI chỉ chứa napp.cjs (KHÔNG kèm SHA commit để luôn lấy bản mới nhất).
// Sau khi Tuấn tạo gist thật, sửa URL này rồi build lại — hoặc ghi đè lúc
// chạy bằng biến môi trường:
//   sudo NAPP_UPDATE_URL="https://gist.githubusercontent.com/<user>/<id>/raw/napp.cjs" napp update
export const NAPP_UPDATE_URL_DEFAULT =
  "https://gist.githubusercontent.com/anhtuank7c/ef7ac27df205d70cf1f789bb420ec013/raw/napp.cjs";

export const CHANGELOG = `\
# Changelog

## 1.18.0
- SỬA: Redis maxmemory-policy volatile-lru -> noeviction. BullMQ kiểm tra lúc
  kết nối và báo 'IMPORTANT! Eviction policy is volatile-lru. It should be
  "noeviction"'. Dữ liệu hàng đợi KHÔNG phải cache: job đang chờ, khoá, kết quả
  chỉ có một bản. Với chính sách *-lru, chạm maxmemory là Redis TỰ TRỤC XUẤT
  key — job bốc hơi giữa chừng, KHÔNG bên nào báo lỗi. volatile-lru cũng không
  thoát: BullMQ CÓ đặt TTL cho khoá, rate-limit, job đã xong. noeviction khiến
  Redis TỪ CHỐI lệnh ghi (OOM) khi đầy — hỏng lộ liễu hơn là mất việc trong im
  lặng. Chính sách áp cho CẢ INSTANCE, không tách theo DB index.
  Đánh đổi: Redis đầy thì ghi mới lỗi OOM chứ không tự dọn -> đặt TTL cho key
  cache (key hết hạn vẫn bị xoá) và theo dõi 'napp redis info'.
- 'napp check' đọc maxmemory-policy ĐANG CHẠY và báo nếu khác noeviction —
  server đã tune bằng bản cũ vẫn đang để volatile-lru, sinh lại template không
  chạm tới chúng. 'napp check --fix' áp ngay bằng CONFIG SET và ghi vào
  /etc/redis/conf.d/napp-tuning.conf (bền qua restart), KHÔNG restart Redis.

## 1.17.0
- ADDRESS_HEADER/XFF_DEPTH giờ là TUỲ CHỌN ('--address-header'), không còn mặc
  định. Chúng đổi thứ getClientAddress() của adapter-node trả về: từ ĐỊA CHỈ
  SOCKET sang giá trị PARSE TỪ HEADER — phá app nào tự phân giải IP khách (lấy
  socket peer, đối chiếu proxy tin cậy, RỒI mới tin header). Hệ quả: app spam
  log "ignoring forwarding headers from untrusted peer ..." mỗi request và rơi
  về tin bất cứ thứ gì XFF_DEPTH chọn. IP thường vẫn ra ĐÚNG, nên nguy hiểm:
  tính đúng đắn phụ thuộc hoàn toàn vào XFF_DEPTH khớp số hop thật, thêm một
  hop sau này là lặng lẽ đọc phải mục CLIENT GIẢ MẠO ĐƯỢC. Giá trị đó thường là
  khoá rate limiter -> hỏng nghĩa là đăng nhập sai KHÔNG GIỚI HẠN.
  App đã tạo không đổi gì; muốn gỡ thì xoá 2 dòng khỏi .env rồi 'napp app
  restart <domain>'.
- Sửa chú thích SAI về XFF_DEPTH: bản cũ ghi "có CDN trước nginx thì tăng lên
  2". Sai khi nginx đã bật Cloudflare real-IP — $remote_addr ĐÃ là IP khách
  thật nên $proxy_add_x_forwarded_for nối thêm chính nó, vẫn là 1.

## 1.16.0
- 'napp app set <domain>': ĐỔI CẤU HÌNH NGINX CỦA APP ĐÃ TẠO. Các tuỳ chọn thêm
  ở 1.15.0 (--static-root/--upload-dir/--hotlink-protect/--max-body) trước đó
  chỉ áp dụng lúc TẠO app; 'napp nginx sync' không giúp được vì nó chỉ vá đúng
  một chuỗi chứ không render lại vhost — cố ý như vậy, vì certbot chèn khối SSL
  thẳng vào vhost nên render lại là xoá HTTPS đang chạy.
- Location riêng của app chuyển sang FILE INCLUDE
  (/etc/nginx/napp-locations/<domain>.conf): vhost chỉ mang ĐÚNG MỘT dòng
  include, nên mọi lần đổi cấu hình về sau chỉ ghi lại một file và KHÔNG BAO
  GIỜ chạm vào vhost. Dòng include được chèn vào khối server đang proxy tới
  upstream của app (dò bằng đếm ngoặc), một lần duy nhất, idempotent, có sao
  lưu + hoàn tác nếu 'nginx -t' trượt.
- SỬA: 'napp domain add/remove' âm thầm làm MẤT HTTPS — regenerateNginxConf ghi
  đè toàn bộ vhost nên khối SSL của certbot biến mất, site tụt về HTTP mà không
  báo gì. Nay có cảnh báo rõ kèm lệnh cấp lại, và sao lưu + hoàn tác.
- SỬA: app tạo bằng bản cũ có thể làm SẬP NGINX TOÀN MÁY — vhost nay include
  file location, mà nginx từ chối khởi động nếu include trỏ vào file không tồn
  tại. 'app create' và 'napp domain' đều ghi file này TRƯỚC khi ghi vhost, kể cả
  khi app không bật tuỳ chọn nào. 'app remove' và rollback đều dọn file.
- NginxAppOptions không còn bản sao của staticRoot/uploadDir/hotlink* — chúng
  chỉ nằm trên AppRecord, tránh dựng lại cái bẫy "tham số không ai đọc".

## 1.15.0
- CẶP WEB + WORKER DÙNG CHUNG REDIS DB: '--share-redis-with <domain|name>' và
  '--redis-db <n>'. Trước đây '--redis' luôn cấp index rảnh kế tiếp, nên web app
  và worker ra HAI DB khác nhau. Hàng đợi chỉ chạy khi bên đẩy và bên tiêu thụ
  nhìn CÙNG keyspace: khác DB thì web đẩy job vào #1, worker nghe #2, KHÔNG BÊN
  NÀO BÁO LỖI — job chất đống, email/thông báo/resize im lặng không chạy. Tạo
  service với '--redis' mà không chỉ định dùng chung thì napp cảnh báo tại chỗ.
  Xoá một đơn vị KHÔNG còn trả index về danh sách trống khi đơn vị khác vẫn dùng.
- '--static-root <dir>' + '--static-prefix <path...>': để NGINX trả asset thay vì
  Node. Vhost trước đây không có 'root' nào nên MỌI file (.js/.css/.woff2) đều đi
  qua Node — một trang SSR/SPA kéo hàng trăm chunk, tất cả xếp hàng trên event
  loop đơn luồng và tranh với chính việc render. Chỉ phục vụ theo TIỀN TỐ khai
  báo (SvelteKit /_app/ · Next.js /_next/static/ · Vite /assets/), không dùng
  try_files chung cho 'location /'.
- '--upload-dir <dir>' (+ '--upload-prefix', mặc định /uploads/): FILE NGƯỜI
  DÙNG TẢI LÊN không phải asset build, '--static-root' KHÔNG thay được. Với
  SvelteKit adapter-node, 'static/' được SAO CHÉP vào build/client LÚC BUILD và
  lúc chạy server chỉ phục vụ build/client — nên ảnh tải lên SAU khi build trả
  404 dù file có thật trên đĩa, rồi TỰ NHIÊN hiện ra sau lần deploy kế tiếp (vì
  build lại sao chép static/), trông như lỗi chập chờn chứ không như lỗi cấu
  hình. Cache-Control ở đây cố ý NGẮN (1 ngày) và KHÔNG 'immutable': tên file
  tải lên không băm nội dung nên cùng một URL có thể đổi nội dung.
- '--hotlink-protect' (+ '--hotlink-allow <domain...>'): chỉ cho nhúng ảnh
  trong --upload-dir từ domain của site. Dùng 'valid_referers ... server_names'
  nên thêm domain phụ là tự động được phép. 'none' và 'blocked' ĐƯỢC PHÉP có
  chủ đích: 'none' gồm cả bot lấy ảnh xem trước khi chia sẻ link (Facebook/
  Zalo/Telegram thường không gửi Referer) — chặn nó là mất ảnh preview ở mọi
  link chia sẻ. GIỚI HẠN: Referer do trình duyệt tự khai (trang hotlink đặt
  <meta name="referrer" content="no-referrer"> là qua được) nên đây chặn
  hotlink TUỲ TIỆN chứ không phải kiểm soát truy cập; và nếu có CDN đứng trước
  thì CDN cache theo URL, không quan tâm Referer, nên chỉ tác dụng với lần
  cache MISS — muốn chặn thật phải bật ở tầng CDN.
- '--max-body <size>' THỰC SỰ có tác dụng: client_max_body_size vẫn luôn là 20M
  vì không chỗ gọi nào truyền tham số đã có sẵn -> upload lớn hơn bị chặn 413
  trước khi tới app. Nay giá trị nằm trong bản ghi app, template đọc thẳng từ đó.
- '--app-dir <path>': chạy được app trong MONOREPO. WorkingDirectory và
  EnvironmentFile trỏ vào thư mục con thay vì gốc repo. Với pnpm, chạy từ gốc
  repo khiến một gói CÓ THẬT vẫn báo ERR_MODULE_NOT_FOUND (Node đi ngược lên từ
  file gọi, pnpm chỉ symlink vào node_modules của package đó); và vì
  EnvironmentFile có tiền tố '-', .env sai chỗ khiến app khởi động RỖNG biến môi
  trường mà không in lỗi. ReadWritePaths vẫn là GỐC mã nguồn.
- 'gzip_proxied any' trong napp-tuning.conf. Chỉ thị này áp dụng khi REQUEST CỦA
  CLIENT mang header 'Via' (không phải "phản hồi từ upstream"). Đo trên trang
  132 KB: không Via thì cả hai đều nén; CÓ Via thì thiếu dòng này trả nguyên
  132 KB. Cloudflare không gửi Via, nhưng Fastly/Varnish/squid thì có.
- Bộ đệm proxy đủ cho trang SSR: proxy_buffer_size 8k->16k, proxy_buffers
  8x8k -> 16x16k. Phần vượt bộ đệm bị nginx ghi ra FILE TẠM trên đĩa rồi đọc
  lại, mỗi request một lần.
- App/service ĐÃ TẠO không đổi hành vi. Áp phần nginx cho app đang chạy:
  'napp nginx sync'.

## 1.14.0
- Thêm 'napp doctor' — soi RỦI RO BẢO MẬT (khác 'napp check' vốn chỉ hỏi môi
  trường đã ĐỦ chưa). Có trong menu tương tác, mục 9.
- 'napp doctor system': liệt kê gói có BẢN VÁ BẢO MẬT đang chờ (đọc từ kho
  '-security' của apt, đánh dấu gói trọng yếu: nginx/OpenSSL/OpenSSH/libc/
  MariaDB/Redis/Node.js/certbot); phát hiện dịch vụ ĐÃ VÁ NHƯNG CHƯA RESTART
  (còn nạp thư viện cũ trong RAM — đọc /proc/<pid>/maps tìm file '(deleted)',
  không cần cài needrestart); đối chiếu phiên bản nginx với bảng CVE nổi bật
  (CVE-2021-23017 RCE qua resolver, HTTP/2 Rapid Reset, module mp4, mTLS
  session resumption...); cảnh báo Node.js đã EOL (hết nhận bản vá); báo khi
  máy cần reboot.
- CVE của nginx được KẾT LUẬN BẰNG BẰNG CHỨNG trên máy, không chỉ so số phiên
  bản: '[ĐÃ VÁ]' khi mã CVE có trong changelog của gói đã cài (bản vá backport
  luôn ghi mã CVE vào /usr/share/doc/nginx-*/changelog.Debian.gz, đọc offline);
  '[KHÔNG DÍNH]' khi module không được biên dịch vào ('nginx -V') hoặc cấu hình
  đang chạy không kích hoạt phần đó ('nginx -T': không mp4, không HTTP/2, không
  resolver, không ssl_verify_client); chỉ báo động khi KHÔNG chứng minh được là
  đã xử lý, kèm lý do còn thiếu bằng chứng nào và lệnh kiểm chứng thủ công.
  Lý do: Ubuntu/Debian vá ngược mà giữ nguyên số upstream, nên nginx 1.24.0 đã
  vá và chưa vá nhìn giống hệt nhau — chỉ so số thì báo động mãi không tắt kể
  cả sau khi đã 'apt upgrade'. Có in kèm phiên bản GÓI (vd 1.24.0-2ubuntu7.5).
- 'napp doctor deps [<domain|name>]': quét rủi ro CHUỖI CUNG ỨNG (dependency
  chain attack) trong mã nguồn từng app/service — thiếu lockfile, dependency
  '*'/'latest', dependency trỏ thẳng git/URL (không có hash toàn vẹn), tên gần
  giống package phổ biến (typosquat), package chạy script khi cài
  (preinstall/install/postinstall), lỗ hổng đã công bố qua audit của chính
  package manager (npm/pnpm/yarn/bun), .npmrc chứa token quyền quá rộng. Mỗi
  phát hiện đều kèm CÁCH XỬ LÝ cụ thể. Thêm '--deep' để tra ngày phát hành của
  dependency trực tiếp trên registry npm (gói bị chiếm thường chỉ sống vài giờ
  tới vài ngày trước khi bị gỡ).
- Output của doctor phân màu theo mức độ: ĐỎ ĐẬM cho NGHIÊM TRỌNG, ĐỎ cho CAO
  (tô cả nội dung, không chỉ nhãn), vàng cho TRUNG BÌNH, xám cho phần tham
  khảo. Gói trọng yếu trong danh sách bản vá được đánh dấu '!' màu đỏ. Thêm mức
  log '[NGUY HIỂM]' (đỏ đậm) cho cảnh báo bảo mật, tách khỏi '[CẢNH BÁO]' vàng
  vốn dùng cho việc vận hành thường.
- 'napp doctor upgrade': LẤY BẢN VÁ VỀ — mặc định chỉ cài bản vá BẢO MẬT
  ('--all' cho mọi cập nhật, '--only nginx' cho một gói). Dùng --force-confold
  nên KHÔNG ghi đè cấu hình đang chạy và không treo ở prompt của dpkg; nâng cấp
  nginx thì chạy 'nginx -t' TRƯỚC khi restart (cấu hình sai thì dừng, không làm
  sập site); sau khi cài chỉ restart đúng những dịch vụ còn nạp thư viện cũ.

## 1.13.1
- Background service KHÔNG còn nằm ở /srv/napp nữa: mã nguồn chuyển về CHUNG
  /var/www với app web để khỏi phân mảnh thư mục và khỏi đi tìm nhiều nơi.
  Phân biệt bằng HẬU TỐ tên thư mục: app web giữ tên domain
  (/var/www/api.example.com), service thêm '-service'
  (/var/www/queue-email-service). Nằm trong /var/www KHÔNG làm service public —
  nginx chỉ phục vụ thư mục nào có vhost trỏ tới, mà service thì không có vhost.
- Áp dụng cho service TẠO MỚI. Service tạo bằng bản cũ vẫn chạy đúng thư mục cũ
  (napp đọc đường dẫn từ registry). Muốn dời sang chỗ mới:
    sudo systemctl stop napp-svc-<name>
    sudo mv /srv/napp/<name> /var/www/<name>-service
    sudo sed -i 's#/srv/napp/<name>#/var/www/<name>-service#g' \\
      /etc/napp/state.json /etc/systemd/system/napp-svc-<name>.service
    sudo systemctl daemon-reload && sudo systemctl start napp-svc-<name>
- Chặn đặt tên service kết thúc bằng '-service' (napp tự thêm hậu tố này) và
  chặn tạo service trùng thư mục với một app web đang có trong registry.

## 1.13.0
- Thêm BACKGROUND SERVICE — ứng dụng Node.js/Bun chạy NGẦM (worker, bot, queue
  consumer, cron poller): KHÔNG domain, KHÔNG nginx/SSL. Nhóm lệnh mới
  'napp service' (create/deploy/remove/list/restart/stop/start/logs/env-set),
  cũng có trong menu tương tác. Mỗi service vẫn có user hệ thống riêng, unit
  systemd (hardening + tự restart), tuỳ chọn --db/--redis, và clone repo private
  qua --token/--ssh-key y như app web.
- Cổng là TUỲ CHỌN cho service: mặc định KHÔNG cấp cổng (worker thuần không
  listen gì). Truyền --port khi service tự bind (health-check/socket) — vẫn
  không public qua nginx.
- Lệnh khởi động đặt tự do qua --start-cmd cho cả framework khác nhau (Express:
  'node src/index.js'; SvelteKit adapter-node: 'node build/index.js'; hoặc
  worker: 'node worker.js'). Mặc định 'npm start' theo package.json.
- Heap V8 nay chia cho TỔNG số đơn vị chạy Node (app web + service) để tổng heap
  không vượt RAM khi có thêm worker. Tự cân đối lại khi tạo/xoá service và khi
  'napp tune apply'. Namespace tách biệt: service dùng user 'nas_*', unit
  'napp-svc-*', mã nguồn ở /var/www/<name>-service — không đụng tài nguyên app web.

## 1.12.2
- Sửa lỗi tạo app runtime bun THẤT BẠI khi repo mang lockfile của trình khác
  (pnpm-lock.yaml / package-lock.json / yarn.lock): bun migrate sang bun.lock
  (=thay đổi lockfile) rồi bị chặn "lockfile had changes, but lockfile is
  frozen" nếu frozen bật (bunfig.toml, biến CI). Nay lệnh cài của bun đã
  "lockfile-aware": có bun.lock -> cài frozen (tất định); không có -> ép
  --no-frozen-lockfile để bun được phép ghi lock migrate. Cùng nếp với
  pnpm/yarn/npm (đều có fallback khi lock lệch).

## 1.12.1
- Phát hành lại (republish) — không đổi tính năng, chỉ tăng version để đẩy bản
  cập nhật qua 'napp update'.

## 1.12.0
- Sửa lỗi TREO khi clone repo PRIVATE lúc tạo app: trước đây git/ssh hỏi
  username/password (HTTPS) hoặc yes/no host-key (SSH) nhưng đọc prompt từ
  terminal điều khiển — mà tiến trình chạy sâu qua 'sudo -u <user app>' không
  sở hữu terminal nên gõ KHÔNG ăn, kẹt vô hạn. Nay MỌI thao tác git (clone +
  deploy) chạy KHÔNG TƯƠNG TÁC (GIT_TERMINAL_PROMPT=0, ssh BatchMode=yes,
  StrictHostKeyChecking=accept-new): repo private thiếu xác thực sẽ báo lỗi
  ngay kèm hướng dẫn, thay vì treo.
- Thêm xác thực repo private không tương tác cho 'napp app create':
    --token <PAT>       clone repo PRIVATE qua HTTPS (lưu vào ~/.git-credentials
                        của user app, quyền 600; remote giữ URL sạch).
    --ssh-key <path>    clone repo PRIVATE qua SSH bằng deploy key (cài vào
                        ~/.ssh + ~/.ssh/config của user app, quyền 600).
  'napp app deploy' dùng lại thông tin này nên pull các bản sau cũng không hỏi.
  Menu tương tác thêm bước hỏi repo có private không rồi xin token/deploy key.

## 1.11.2
- Sửa cảnh báo "getcwd: cannot access parent directories" khi tạo app: lệnh chạy
  dưới user hệ thống của app kế thừa CWD của napp (thường /root, user app không
  vào được). Nay runAs mặc định cwd="/" nếu không chỉ định -> hết cảnh báo. App
  vẫn tạo đúng như trước; đây chỉ là dọn tiếng ồn.

## 1.11.1
- App mới: thêm khối GỢI Ý (comment) về CSRF của SvelteKit vào .env. adapter-node
  chặn POST/form action bằng 403 "Cross-site POST form submissions are forbidden"
  khi origin lệch; PROTOCOL_HEADER/HOST_HEADER (đã có sẵn từ 1.10.0) khắc phục,
  kèm dòng '# ORIGIN=https://<domain>' đã comment để bật TAY sau khi cấp SSL nếu
  vẫn dính 403. Output tạo app thêm một dòng nhắc trỏ tới ghi chú này.

## 1.11.0
- Xoá app KHÔNG còn mặc định xoá sạch mọi thứ: 'napp app remove' giờ CHỌN từng
  tài nguyên cần xoá — cấu hình nginx, chứng chỉ SSL, mã nguồn (+ user), database.
  Mặc định XOÁ nginx + ssl, GIỮ mã nguồn + database (dữ liệu quý, tránh mất trắng).
  Menu tương tác hiện danh sách [x] tick chọn nhiều mục. Cờ CLI mới: --all,
  --source, --db, --keep-nginx, --keep-ssl (--keep-db vẫn nhận cho tương thích).
  Service systemd LUÔN bị gỡ vì app rời khỏi registry thì napp không quản lý được.

## 1.10.0
- Sửa BUG header WebSocket: vhost ép cứng 'Connection: upgrade' cho MỌI request,
  kể cả HTTP thường (Upgrade rỗng) -> header méo + phá keepalive tới upstream.
  Nay dùng map \\$napp_connection_upgrade (conf.d/00-napp-proxy.conf): chỉ request
  WebSocket thật mới upgrade. Chạy 'napp nginx sync' để vá các app ĐANG CHẠY
  (vá tại chỗ, KHÔNG đụng khối SSL certbot đã chèn).
- App mới tự có PROTOCOL_HEADER/HOST_HEADER/ADDRESS_HEADER/XFF_DEPTH trong .env:
  SvelteKit adapter-node mặc định không tin X-Forwarded-*, nên app tưởng mình
  chạy HTTP dù người dùng vào bằng HTTPS -> code redirect "chưa https" lặp vô
  hạn, cookie Secure/CSRF sai. App CŨ: thêm tay rồi 'napp app restart'.

## 1.9.0
- Backup: menu tự LIỆT KÊ database để chọn (một DB cụ thể hoặc tất cả). Cờ mới
  'backup run --database <name>'. File backup vẫn nén gzip (.sql.gz / .tar.gz).
- Retention theo NGÀY: 'backup run/schedule --keep-days <n>' (mặc định 14) xoá
  bản cũ hơn N ngày; tuỳ chọn '--keep <n>' giới hạn thêm số bản gần nhất.
- 'backup list' hiển thị kích thước từng file + tổng dung lượng. Menu backup
  tách rõ: backup DB / files / tất cả / lên lịch / gỡ lịch / danh sách.

## 1.8.0
- 'napp nginx harden': tạo server MẶC ĐỊNH (default_server) trả 444 cho mọi
  request KHÔNG khớp domain đã cấu hình — chặn truy cập thẳng IP, Host giả mạo,
  bot quét cổng; chỉ domain có app (server_name khớp) mới vào được. Chặn cả 80
  và 443 (ssl_reject_handshake trên nginx >= 1.19.4, hoặc cert tự ký trên bản
  cũ). Ẩn phiên bản nginx (server_tokens off). 'napp nginx unharden' để gỡ.
  Có sẵn trong menu Hạ tầng.

## 1.7.1
- 'napp cert issue' tiền kiểm DNS: certbot cấp MỘT chứng chỉ cho mọi -d, chỉ
  cần một domain chưa có DNS (ví dụ www chưa trỏ) là hỏng cả. Nay napp bỏ các
  domain chưa phân giải (A/AAAA) kèm cảnh báo, để phần còn lại vẫn cấp được;
  nếu domain CHÍNH chưa phân giải thì báo lỗi rõ ràng.

## 1.7.0
- Sửa 'napp cert issue' bị TREO ở prompt nhập email của certbot: nay chạy
  --non-interactive --agree-tos --email (nhớ email trong state cho lần sau) và
  --redirect (tự thêm chuyển HTTP->HTTPS). Cờ mới: --email, --register-without-email,
  --no-redirect. Thiếu email thì báo lỗi rõ ràng thay vì treo.
- Menu SSL: phát hành / gia hạn / thu hồi giờ CHỌN domain từ danh sách app; thêm
  mục 'Thu hồi / gỡ chứng chỉ' và 'Gia hạn một domain'.

## 1.6.1
- Sửa lỗi tạo app thất bại + rollback khi chọn pnpm/yarn chưa cài (báo
  'command not found' dưới app user). Nay napp kiểm tra pm có ở MỨC HỆ THỐNG
  (/usr, /opt) không — nếu chưa, tự 'npm install -g pnpm|yarn' để app user và
  systemd đều dùng được, và fail SỚM (trước khi tạo tài nguyên) nếu bun thiếu.
  Deploy cũng tự đảm bảo pm trước khi cài deps.

## 1.6.0
- Heap V8 (--max-old-space-size) giờ CHIA THEO SỐ APP: ngân sách RAM cho app
  (RAM − MariaDB/Redis/OS) chia đều cho số app, để tổng heap vừa với RAM (quan
  trọng trên máy 1GB chạy nhiều app). Tự cân đối lại khi TẠO/XOÁ app (ghi lại
  unit + restart các app khác) và khi 'napp tune apply'. Ví dụ 1GB: 1 app=384MB,
  2 app=230MB, 3 app=153MB mỗi app.

## 1.5.0
- NODE_OPTIONS (--max-old-space-size) tự tính theo RAM/tier cho app runtime=node,
  đặt trong unit systemd (user override được qua .env). bun không set (dùng JSC).
- systemd unit đổi ProtectHome=yes -> tmpfs: vẫn giấu home thật nhưng cấp \$HOME
  rỗng ghi được, thân thiện runtime (bun/node) hơn.
- 'napp tune apply' giờ cũng ghi lại unit mọi app (áp NODE_OPTIONS + hardening
  mới) và khởi động lại; 'napp tune show' hiển thị heap dự kiến.
- Redis maxmemory-policy: allkeys-lru -> volatile-lru (an toàn hơn khi nhiều app
  dùng chung Redis — chỉ trục xuất key có TTL).

## 1.4.0
- Banner giới thiệu napp (ASCII, có màu, kèm phiên bản động + gợi ý lệnh) hiển
  thị mỗi khi đăng nhập SSH. Cài bởi 'napp install', gỡ bởi 'napp uninstall'.
  'napp update' tự làm mới banner nếu đang bật.

## 1.3.0
- Thêm systemd timer tự động đồng bộ IP Cloudflare vào nginx (real-IP):
  \`napp cloudflare schedule [--time HH:MM]\` (mặc định 01:00 hàng ngày) và
  \`napp cloudflare unschedule\`. Cũng có trong menu Hạ tầng.

## 1.2.0
- Tường lửa UFW KHÔNG còn giới hạn 80/443 chỉ cho dải IP Cloudflare theo mặc
  định — nay mở 80/443 công khai. Việc lấy IP client thật là của nginx real-IP
  (\`napp cloudflare sync\`), KHÔNG liên quan tới UFW. Muốn khoá origin theo IP
  Cloudflare (nâng cao) thì thêm cờ \`--restrict-cloudflare\`.
- Timer đồng bộ Cloudflare chỉ còn refresh nginx real-IP, không đụng UFW nữa.

## 1.1.0
- Chọn TRÌNH QUẢN LÝ GÓI (npm/pnpm/yarn/bun) khi tạo app, tách bạch khỏi
  runtime engine (node/bun). Cờ mới: --package-manager. Lệnh cài mặc định
  của mọi PM đều "lockfile-aware" (chỉ cài theo lock khi có lockfile).
- Menu tương tác: deploy/restart/xem-log/xoá giờ XỔ DANH SÁCH app để chọn
  theo số thứ tự, không cần gõ tay domain nữa.
- Sửa: 'npm ci' chỉ chạy khi có package-lock.json (app mẫu/repo không lock
  không còn phun lỗi EUSAGE).
- Wire nguồn tự cập nhật (napp update) tới gist chính thức.

## 1.0.0
- Phát hành đầu tiên: quản lý app Node.js/Bun đa người dùng, domain, SSL
  (certbot), MariaDB, Redis, systemd service/timer, nginx + Cloudflare real
  IP, fail2ban, UFW, backup định kỳ, tối ưu theo phần cứng, tự cập nhật OTA
  qua gist.
`;

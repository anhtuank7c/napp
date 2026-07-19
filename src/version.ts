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

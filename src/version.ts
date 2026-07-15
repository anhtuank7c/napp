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

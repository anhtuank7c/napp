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

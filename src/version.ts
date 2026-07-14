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
  "https://gist.githubusercontent.com/anhtuank7c/REPLACE_WITH_GIST_ID/raw/napp.cjs";

export const CHANGELOG = `\
# Changelog

## 1.0.0
- Phát hành đầu tiên: quản lý app Node.js/Bun đa người dùng, domain, SSL
  (certbot), MariaDB, Redis, systemd service/timer, nginx + Cloudflare real
  IP, fail2ban, UFW, backup định kỳ, tối ưu theo phần cứng, tự cập nhật OTA
  qua gist.
`;

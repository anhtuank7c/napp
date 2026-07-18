# Changelog

Tất cả thay đổi đáng chú ý của `napp` được ghi lại ở đây.

## 1.11.0

- **Xoá app không còn mặc định xoá cả database**. `napp app remove` giờ cho **chọn từng tài nguyên** cần xoá khi gỡ app: **cấu hình nginx**, **chứng chỉ SSL**, **mã nguồn** (kèm user hệ thống), **database**. Mặc định **xoá nginx + ssl** (an toàn, dễ tạo lại) và **GIỮ mã nguồn + database** (dữ liệu quý — xoá nhầm là mất trắng) trừ khi người dùng chủ động chọn.
  - **Menu tương tác**: hiện danh sách **tick chọn nhiều mục** (`[x]` = sẽ xoá) — gõ số để bật/tắt, Enter để xác nhận. nginx + ssl tick sẵn.
  - **CLI**: cờ mới `--all` (xoá tất cả), `--source` (xoá luôn mã nguồn + user), `--db` (xoá luôn database), `--keep-nginx`, `--keep-ssl`. `--keep-db` vẫn nhận để **tương thích script cũ** (nay database mặc định đã được giữ). Ví dụ: `napp app remove api.example.com --yes` chỉ xoá nginx + ssl; thêm `--all` để xoá sạch.
  - **Service systemd luôn bị gỡ** vì app rời khỏi registry thì napp không quản lý được service nữa. SSL dùng `certbot delete` (chỉ xoá cert + cấu hình gia hạn ở local, không gọi mạng).

## 1.10.0

- **Sửa bug header WebSocket gửi sai cho mọi request**. Vhost trước đây ép cứng `proxy_set_header Connection "upgrade"` cho **mọi** request. Với request HTTP thường, `$http_upgrade` rỗng nên nginx gửi `Connection: upgrade` kèm `Upgrade:` rỗng — **header méo**, đồng thời **phá `keepalive 32`** khai báo trong khối `upstream` (keepalive tới upstream đòi hỏi `Connection` rỗng). Nay dùng `map $http_upgrade $napp_connection_upgrade` đặt tại `/etc/nginx/conf.d/00-napp-proxy.conf`: **chỉ request WebSocket thật sự mới `Connection: upgrade`**, request thường dùng keep-alive đúng chuẩn.
- **Lệnh mới `napp nginx sync`** để áp bản sửa trên cho các app **đang chạy**: ghi file map dùng chung rồi **vá tại chỗ** từng vhost. Cố ý **không render lại** vhost — render lại sẽ xoá sạch khối SSL mà certbot đã chèn và làm sập HTTPS của site. Có sao lưu + tự hoàn tác nếu `nginx -t` trượt.
- **App mới tự cấu hình cho app chạy sau reverse proxy**: `.env` nay có `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=host`, `ADDRESS_HEADER=x-forwarded-for`, `XFF_DEPTH=1`. Lý do: `adapter-node` của **SvelteKit** mặc định **không tin** các header `X-Forwarded-*`, nên app tưởng mình đang chạy HTTP kể cả khi người dùng vào bằng HTTPS (nginx mới là chỗ kết thúc TLS) — mọi đoạn code kiểu *"chưa https thì redirect sang https"* sẽ **lặp vô hạn** (`ERR_TOO_MANY_REDIRECTS`), cookie `Secure` và kiểm tra CSRF cũng sai theo. Cố ý **không** đặt `ORIGIN` cứng để vhost chạy đúng cả trước lẫn sau khi cấp SSL. App **cũ** cần thêm tay vào `.env` rồi `napp app restart`.

## 1.9.0

- **Backup chọn database + retention theo ngày**:
  - Menu backup **tự liệt kê database** để chọn — backup **một DB cụ thể** hoặc **tất cả**. CLI: `napp backup run --database <name>`.
  - **Retention theo NGÀY**: `--keep-days <n>` (mặc định 14) xoá các bản cũ hơn N ngày, cho cả `backup run` và `backup schedule`. Tuỳ chọn `--keep <n>` giới hạn thêm theo số bản gần nhất.
  - File backup **nén gzip** (`.sql.gz` cho DB, `.tar.gz` cho mã nguồn) — tiết kiệm dung lượng.
  - `backup list` hiển thị **kích thước từng file + tổng dung lượng**. Menu backup tách rõ: DB / files / tất cả / lên lịch / gỡ lịch / danh sách.

## 1.8.0

- **`napp nginx harden` — chặn truy cập IP/Host lạ + hardening**. Tạo một **server mặc định** (`default_server`) trả **HTTP 444** (đóng kết nối, không lộ thông tin) cho mọi request **không khớp** `server_name` của app nào — chặn truy cập thẳng vào IP máy chủ, Host giả mạo, bot quét cổng. **Chỉ domain đã tạo app mới truy cập được.** Chặn cả **80 và 443** (dùng `ssl_reject_handshake` trên nginx ≥ 1.19.4, hoặc chứng chỉ tự ký trên bản cũ hơn). Ẩn phiên bản nginx (`server_tokens off`). Tự gỡ site `default` của Ubuntu để tránh trùng `default_server`. Kèm `napp nginx unharden` để gỡ. Có trong menu Hạ tầng.

## 1.7.1

- **`napp cert issue` tiền kiểm DNS**: certbot cấp **một** chứng chỉ cho tất cả `-d`, nên chỉ một domain chưa có DNS (điển hình là `www` chưa trỏ) là **hỏng cả chứng chỉ**. Nay napp kiểm tra A/AAAA từng domain trước, **bỏ domain chưa phân giải** kèm cảnh báo (để phần còn lại vẫn cấp được), và **báo lỗi rõ ràng** nếu domain chính chưa phân giải. Chỉ kiểm tra "có phân giải" chứ không so IP với server, nên domain bật proxy Cloudflare vẫn cấp bình thường.

## 1.7.0

- **Sửa `napp cert issue` bị treo** ở prompt nhập email của certbot. Nay chạy **không tương tác**: `--non-interactive --agree-tos --email <email>` (email được **nhớ trong state** cho các lần sau) + `--redirect` (tự thêm chuyển hướng HTTP→HTTPS). Cờ mới: `--email`, `--register-without-email` (đăng ký không email, không khuyến nghị), `--no-redirect`. Thiếu email → **báo lỗi rõ ràng** thay vì treo.
- **Menu SSL chọn domain từ danh sách app**: phát hành / gia hạn / thu hồi giờ xổ danh sách app để chọn (không gõ tay). Thêm mục **"Thu hồi / gỡ chứng chỉ"** và **"Gia hạn một domain"** (bên cạnh "Gia hạn tất cả"). Phát hành trong menu có hỏi email (mặc định dùng email đã nhớ).

## 1.6.1

- **Sửa lỗi tạo app thất bại khi chọn pnpm/yarn chưa cài** (`pnpm: command not found` rồi rollback toàn bộ). Nguyên nhân: tiền kiểm `commandExists` chỉ dò PATH của **root** (root có thể có pnpm trong home) nhưng app user chạy install lại không thấy. Nay napp kiểm tra pm có ở **mức hệ thống** (`/usr`, `/opt`, `/bin`) không; nếu chưa thì **tự `npm install -g <pm>`** (để app user + systemd đều dùng được), và **fail sớm** trước khi tạo tài nguyên (không còn tạo-rồi-rollback). `napp app deploy` cũng tự đảm bảo pm trước khi cài deps. bun thiếu → báo lỗi rõ ràng với hướng dẫn cài system-wide.

## 1.6.0

- **Heap V8 chia sẻ theo số app**: `--max-old-space-size` mỗi app node giờ = (ngân sách RAM cho app = RAM − MariaDB − Redis − OS) ÷ số app, kẹp trong [128MB, trần theo tier]. Nhờ vậy tổng heap của mọi app vừa với RAM — quan trọng khi chạy nhiều app trên máy nhỏ.
  - **Tự cân đối lại** khi `napp app create` / `napp app remove` (ghi lại unit của các app còn lại + restart chúng để áp cap mới) và khi `napp tune apply`.
  - Ví dụ trên **1GB RAM**: 1 app → 384 MB, 2 app → 230 MB, 3 app → 153 MB mỗi app (tổng luôn nằm trong ngân sách ~461 MB).
  - `napp app create` mới sẽ khiến các app đang chạy **khởi động lại** một nhịp ngắn để nhường bớt heap.

## 1.5.0

- **NODE_OPTIONS heap V8 theo phần cứng**: app `runtime=node` được đặt `NODE_OPTIONS=--max-old-space-size=<MB>` trong unit systemd, với `<MB>` suy từ RAM/tier (một GIỚI HẠN mỗi app, không phải RAM đặt trước). Đặt **trước** `EnvironmentFile` nên `.env` của bạn ghi đè được. App `runtime=bun` **không** set (bun dùng JavaScriptCore, không hiểu cờ heap của V8).
- **`ProtectHome=yes` → `ProtectHome=tmpfs`** trong unit: vẫn giấu mọi home thật nhưng cấp cho service một `$HOME` rỗng ghi được (ephemeral) — thân thiện với runtime hay ghi cache vào home (bun `~/.bun`, node `~/.npm`).
- **`napp tune apply`** giờ ghi lại unit systemd của **mọi app** (cập nhật NODE_OPTIONS cho app node + lan `ProtectHome=tmpfs` sang app cũ) rồi khởi động lại; `napp tune show` hiển thị heap dự kiến. Có `--skip-restart` để chỉ ghi file.
- **Redis `maxmemory-policy`: `allkeys-lru` → `volatile-lru`** — vì nhiều app dùng chung một Redis (mỗi app một DB index), `allkeys-lru` có thể để cache của app này trục xuất session/queue không-TTL của app khác. `volatile-lru` chỉ trục xuất key **có TTL**. (Đặt TTL cho key cache; nếu Redis của bạn thuần cache không TTL thì đổi lại `allkeys-lru`.)

## 1.4.0

- **Banner giới thiệu khi đăng nhập SSH**: `napp install` cài banner ASCII (có màu, hiển thị phiên bản động qua `napp version` + gợi ý các lệnh chính) vào `/etc/update-motd.d/99-napp`; hiện mỗi lần SSH vào server. `napp uninstall` gỡ banner. `napp update` tự làm mới banner theo bản mới nếu banner đang bật. Tôn trọng biến môi trường `NO_COLOR`.

## 1.3.0

- **Tự động đồng bộ IP Cloudflare theo lịch**: `napp cloudflare schedule [--time HH:MM]` tạo systemd timer chạy `cloudflare sync` **hàng ngày** (mặc định **01:00**) để cập nhật danh sách IP Cloudflare trong nginx real-IP; `napp cloudflare unschedule` để gỡ. Có sẵn trong menu Hạ tầng. Timer chỉ refresh nginx, không đụng tường lửa.

## 1.2.0

- **UFW không còn khoá 80/443 theo IP Cloudflare** (thay đổi hành vi). Mặc định `napp firewall sync` mở 80/443 công khai. Việc khôi phục IP client thật khi traffic đi qua Cloudflare là nhiệm vụ của **nginx real-IP** (`napp cloudflare sync` → `set_real_ip_from` + `real_ip_header CF-Connecting-IP`), hoàn toàn tách biệt khỏi tường lửa.
  - Muốn khoá origin (chỉ nhận traffic từ dải IP Cloudflare, chống bypass thẳng vào origin IP) thì dùng cờ **`--restrict-cloudflare`** (nâng cao, opt-in).
  - Timer đồng bộ Cloudflare giờ chỉ refresh nginx real-IP, không chạm vào UFW.
  - Chạy lại `napp firewall sync` sẽ tự dọn các rule `napp: Cloudflare` cũ và thay bằng một rule mở 80/443.

## 1.1.0

- **Chọn trình quản lý gói** (`npm`/`pnpm`/`yarn`/`bun`) khi tạo app, tách bạch khỏi runtime engine (`node`/`bun`). Cờ mới `--package-manager`, và hỏi trong menu tương tác. Lệnh cài mặc định của mọi package manager đều *lockfile-aware*: chỉ cài đúng theo lockfile khi có (nhanh, tất định), không có thì cài thẳng.
- **Menu chọn app từ danh sách**: `deploy`/`restart`/`xem log`/`xoá` giờ xổ danh sách app (kèm trạng thái chạy) để chọn theo số thứ tự — không phải gõ tay domain nữa.
- **Sửa lỗi** `npm ci` phun tường lỗi `EUSAGE` khi tạo app mẫu / repo không commit lockfile (giờ chỉ chạy `npm ci` khi có `package-lock.json`/`npm-shrinkwrap.json`).
- Wire nguồn tự cập nhật (`napp update`) tới gist chính thức.

## 1.0.0 — Phát hành đầu tiên

- Quản lý app Node.js/Bun đa người dùng: `napp app create/deploy/remove/list/restart/stop/start/logs/env-set`
- Domain phụ (alias): `napp domain add/remove/list`
- SSL miễn phí qua certbot: `napp cert issue/renew/revoke/list/status`
- Database MariaDB độc lập + tự động cho app: `napp db create/drop/list/backup`, cờ `--db` khi tạo app
- Redis dùng chung, cấp DB index riêng (0-15) cho từng app: `napp redis info/allocations/flush`, cờ `--redis`
- systemd service riêng cho từng app (hardened: NoNewPrivileges, ProtectSystem=strict, ...)
- nginx reverse-proxy tự sinh + tích hợp Cloudflare real-IP (`napp cloudflare sync`)
- UFW: `napp firewall sync` — mặc định deny, chỉ mở SSH + 80/443 (giới hạn theo dải IP Cloudflare, tự phát hiện IPv6 khả dụng hay không)
- fail2ban: `napp fail2ban setup` — sshd + nginx + jail chống spam lỗi 502/504/429
- Backup định kỳ qua systemd timer: `napp backup run/schedule/unschedule/list`
- Tối ưu theo phần cứng thực tế: `napp tune show/apply` (nginx/MariaDB/Redis/sysctl, tự phát hiện CPU/RAM)
- Kiểm tra & tự cài môi trường: `napp check [--fix]` (Node.js, sudo, git, nginx, certbot, MariaDB, Redis, fail2ban, UFW)
- Tự cập nhật OTA qua gist công khai: `napp update`
- Menu tương tác tiếng Việt dạng số
- Hỗ trợ `--dry-run` và `--verbose` toàn cục

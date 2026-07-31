# Changelog

Tất cả thay đổi đáng chú ý của `napp` được ghi lại ở đây.

## 1.14.0

- **Thêm `napp doctor` — soi rủi ro bảo mật.** `napp check` hỏi *"môi trường đã ĐỦ chưa"*; `doctor` hỏi *"môi trường có ĐANG AN TOÀN không"*. Có trong menu tương tác (mục 9).
- **`napp doctor system`**:
  - Liệt kê gói có **bản vá bảo mật đang chờ**, đọc từ kho `-security` của apt (`apt-get -s dist-upgrade`), đánh dấu `!` cho gói trọng yếu: nginx, OpenSSL, OpenSSH, libc, MariaDB, Redis, Node.js, certbot…
  - Phát hiện **dịch vụ đã vá nhưng chưa restart** — vá gói xong mà tiến trình vẫn giữ `libssl` cũ **trong RAM** thì bản vá chưa có hiệu lực. napp đọc `/proc/<pid>/maps` tìm thư viện bị đánh dấu `(deleted)`, không cần cài thêm `needrestart`.
  - Đối chiếu **bảng CVE nổi bật** của nginx (CVE-2021-23017 RCE qua resolver, CVE-2023-44487 HTTP/2 Rapid Reset, CVE-2024-7347 & CVE-2022-41741/41742 module mp4, CVE-2025-23419 mTLS session resumption…) rồi **kết luận bằng bằng chứng trên máy** thay vì chỉ so số phiên bản: `[ĐÃ VÁ]` khi mã CVE có trong changelog của gói đã cài (`/usr/share/doc/nginx-*/changelog.Debian.gz` — bản vá backport luôn ghi mã CVE vào đây, đọc offline); `[KHÔNG DÍNH]` khi module không được biên dịch vào (`nginx -V`) hoặc cấu hình đang chạy không kích hoạt phần đó (`nginx -T`: không `mp4`, không HTTP/2, không `resolver`, không `ssl_verify_client`); chỉ báo động khi **không chứng minh được là đã xử lý**, kèm dòng *"vì sao còn nằm đây"* và lệnh kiểm chứng thủ công.
  - Lý do: Ubuntu/Debian vá ngược mà giữ nguyên số upstream, nên `nginx 1.24.0` đã vá và chưa vá nhìn giống hệt nhau — công cụ chỉ so số sẽ báo động mãi không tắt kể cả sau khi người dùng đã `apt upgrade`.
  - Cảnh báo **Node.js đã EOL** (không còn nhận bản vá nào nữa) và khi máy **cần reboot**.
  - Hiển thị thêm **phiên bản gói** của bản phân phối (vd `nginx-core 1.24.0-2ubuntu7.5`) bên cạnh số upstream — đây mới là con số phản ánh đã nhận bản vá tới đâu. Bảng CVE nằm trong binary nên cần `napp update` để làm mới; `[KHÔNG DÍNH]` dựa trên cấu hình tại thời điểm quét nên đổi cấu hình thì phải quét lại.
- **`napp doctor deps [<domain|name>]` — quét rủi ro chuỗi cung ứng** (dependency chain attack) trong mã nguồn từng app/service: thiếu lockfile, dependency `*`/`latest`, dependency trỏ thẳng git/URL (không có hash toàn vẹn), tên gần giống package phổ biến (typosquat), package chạy script khi cài (`preinstall`/`install`/`postinstall`), lỗ hổng đã công bố qua audit của chính package manager (npm/pnpm/yarn/bun — tự nhận diện yarn classic vs berry), `.npmrc` chứa token với quyền quá rộng. **Mỗi phát hiện đều kèm cách xử lý cụ thể.** Cờ `--deep` tra thêm ngày phát hành của dependency trực tiếp trên registry npm: gói bị chiếm tài khoản thường chỉ sống vài giờ tới vài ngày trước khi bị gỡ, nên bản còn quá mới là lúc đáng dừng lại kiểm tra.
- **Phân màu theo mức độ**: đỏ đậm cho `[NGHIÊM TRỌNG]`, đỏ cho `[CAO]` (tô cả nội dung chứ không chỉ nhãn), vàng cho `[TRUNG BÌNH]`, xám cho phần tham khảo; gói trọng yếu trong danh sách bản vá được đánh dấu `!` đỏ. Thêm mức log `[NGUY HIỂM]` (đỏ đậm) cho cảnh báo **bảo mật**, tách khỏi `[CẢNH BÁO]` vàng vốn dùng cho việc vận hành thường. Màu tự tắt khi output không phải terminal (ghi log/journal vẫn sạch).
- **`napp doctor upgrade` — lấy bản vá về**: mặc định **chỉ cài bản vá bảo mật** (`--all` cho mọi cập nhật, `--only nginx` cho một nhóm gói). Dùng `--force-confold` nên dpkg **không ghi đè cấu hình đang chạy** và không treo ở prompt tương tác; khi có nâng cấp nginx thì chạy `nginx -t` **trước** khi restart (cấu hình sai thì dừng lại thay vì làm sập site); cài xong chỉ restart đúng những dịch vụ còn nạp thư viện cũ.

## 1.13.1

- **Background service không còn nằm ở `/srv/napp`** — mã nguồn chuyển về **chung `/var/www`** với app web để khỏi phân mảnh thư mục, khỏi phải đi tìm ở nhiều nơi. Phân biệt bằng **hậu tố tên thư mục**: app web giữ nguyên tên domain (`/var/www/api.example.com`), background service thêm `-service` (`/var/www/queue-email-service`). Nằm trong `/var/www` **không** làm service public: nginx chỉ phục vụ thư mục nào có vhost trỏ tới, mà service thì không có vhost — user hệ thống (`nas_*`) và unit systemd (`napp-svc-*`) vẫn tách biệt hoàn toàn với app web.
- Áp dụng cho service **tạo mới**. Service tạo bằng bản cũ vẫn chạy đúng thư mục cũ vì napp đọc đường dẫn từ registry (`/etc/napp/state.json`). Muốn dời sang layout mới:

  ```bash
  sudo systemctl stop napp-svc-<name>
  sudo mv /srv/napp/<name> /var/www/<name>-service
  sudo sed -i 's#/srv/napp/<name>#/var/www/<name>-service#g' \
    /etc/napp/state.json /etc/systemd/system/napp-svc-<name>.service
  sudo systemctl daemon-reload && sudo systemctl start napp-svc-<name>
  ```

- **Chặn tên service kết thúc bằng `-service`** (napp tự thêm hậu tố, nếu không sẽ có hai service tranh nhau cùng một thư mục) và **chặn tạo service trùng thư mục** với một app web đang có trong registry.

## 1.13.0

- **Thêm BACKGROUND SERVICE** — ứng dụng Node.js/Bun chạy **ngầm** (worker, bot, queue consumer, cron poller): không domain, không nginx/SSL. Nhóm lệnh mới `napp service` (`create`/`deploy`/`remove`/`list`/`restart`/`stop`/`start`/`logs`/`env-set`), cũng có trong menu tương tác. Mỗi service có user hệ thống riêng, unit systemd (hardening + tự restart), tuỳ chọn `--db`/`--redis`, và clone repo private qua `--token`/`--ssh-key` y như app web.
- **Cổng là tuỳ chọn** cho service: mặc định không cấp cổng (worker thuần không listen gì). Truyền `--port` khi service tự bind (health-check/socket) — vẫn không public qua nginx.
- **Lệnh khởi động tự do** qua `--start-cmd` cho các framework khác nhau (Express `node src/index.js`, SvelteKit adapter-node `node build/index.js`, worker `node worker.js`). Mặc định `npm start` theo `package.json`.
- **Heap V8 chia cho tổng số đơn vị chạy Node** (app web + service) để tổng heap không vượt RAM khi có thêm worker; tự cân đối lại khi tạo/xoá service và khi `napp tune apply`.

## 1.12.2

- **Sửa lỗi tạo app runtime `bun` thất bại khi repo mang lockfile của trình khác** (`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`). `bun install` migrate lockfile ngoại sang `bun.lock` — tức **thay đổi lockfile** — rồi bị chặn `lockfile had changes, but lockfile is frozen` nếu frozen được bật (qua `bunfig.toml` `frozenLockfile = true`, biến `CI`, ...). Nay lệnh cài của bun đã **lockfile-aware**: có `bun.lock`/`bun.lockb` → cài `--frozen-lockfile` (tất định), fallback ghi lại nếu lock lệch; **không có** → ép `--no-frozen-lockfile` để bun được phép ghi lockfile migrate. Đồng bộ cách làm với pnpm/yarn/npm.

## 1.12.1

- **Phát hành lại** (republish) — không đổi tính năng, chỉ tăng version để đẩy bản cập nhật qua `napp update`.

## 1.12.0

- **Sửa lỗi TREO khi clone repo private lúc tạo app**. Trước đây với repo **private**, `git`/`ssh` hỏi username/password (HTTPS) hoặc `yes/no` host-key (SSH) nhưng đọc câu trả lời từ **terminal điều khiển** — mà tiến trình chạy sâu qua `sudo -u <user hệ thống của app>` **không sở hữu terminal**, nên prompt hiện ra mà **gõ không ăn**, kẹt vô hạn. Nay **mọi thao tác git** (clone khi tạo app + fetch/reset khi deploy) chạy **KHÔNG TƯƠNG TÁC** (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode=yes`, `StrictHostKeyChecking=accept-new`): repo private thiếu xác thực sẽ **báo lỗi ngay kèm hướng dẫn**, thay vì treo.
- **Thêm xác thực repo private cho `napp app create`** (không tương tác):
  - `--token <PAT>` — clone repo private qua **HTTPS**. Token lưu vào `~/.git-credentials` của user app (quyền `600`) qua `credential.helper=store`; **remote giữ URL sạch**, token không nhúng vào `.git/config`.
  - `--ssh-key <path>` — clone repo private qua **SSH** bằng **deploy key**. Key được cài vào `~/.ssh/napp_deploy` + `~/.ssh/config` của user app (quyền `600`), ghim đúng key cho host.
  - `napp app deploy` **dùng lại** thông tin đã lưu nên các lần pull sau cũng không hỏi.
  - `--ssh-key` nhận **cả đường dẫn file lẫn nội dung key dán trực tiếp**; key bị cắt cụt (thiếu dòng `-----END`) bị chặn ngay với thông báo rõ, không clone lỗi âm thầm.
  - **Menu tương tác** thêm bước hỏi repo có private không rồi xin token/deploy key theo giao thức; ô nhập deploy key **đọc trọn khối key nhiều dòng** khi dán (trước đây readline chỉ lấy 1 dòng nên key bị cắt).

## 1.11.2

- **Sửa cảnh báo `getcwd: cannot access parent directories` khi tạo app**. Các lệnh chạy dưới **user hệ thống của app** (`runAs`) kế thừa thư mục làm việc của tiến trình `napp` — thường là `/root` khi chạy `sudo napp` — mà user app **không có quyền truy cập**, nên shell con phun `shell-init: error retrieving current directory: getcwd...`. App vẫn được tạo đúng (heredoc dùng đường dẫn tuyệt đối), đây chỉ là **tiếng ồn gây hoang mang**. Nay `runAs` mặc định `cwd="/"` khi caller không chỉ định (mọi user đều traverse được) → hết cảnh báo.

## 1.11.1

- **Gợi ý CSRF cho app SvelteKit ngay trong `.env`**. App mới nay được chèn một **khối ghi chú** vào `.env` giải thích: `adapter-node` **chặn mọi POST/form action** bằng lỗi `403 "Cross-site POST form submissions are forbidden"` khi `Origin` trình duyệt gửi lên không khớp origin server tự suy ra — sau reverse proxy server chỉ thấy `http://127.0.0.1` nên rất dễ lệch. Cặp `PROTOCOL_HEADER`/`HOST_HEADER` (đã tự có từ 1.10.0) cho adapter dựng lại đúng `https://<domain>` nên **thường không cần làm gì thêm**; kèm sẵn dòng `# ORIGIN=https://<domain>` đã comment để **bật tay sau khi cấp SSL** nếu vẫn dính 403 hoặc muốn ghim cứng origin. Phần **"Các bước tiếp theo"** khi tạo app cũng thêm một dòng nhắc trỏ tới ghi chú này.

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

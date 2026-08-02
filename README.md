# napp — Công cụ quản lý server Node.js/Bun đa ứng dụng (một file duy nhất)

`napp` giúp **tạo, triển khai và quản lý nhiều ứng dụng Node.js/Bun** trên cùng
một máy chủ Ubuntu — phiên bản "Node.js" của [`lara`](https://gist.github.com/anhtuank7c/c2b5a523e2bf8bdcacad8b7c0e4856ac)
(công cụ tương tự cho PHP/Laravel), viết bằng TypeScript, đóng gói thành một
file `napp.cjs` duy nhất chạy bằng Node.js.

Mỗi app chạy dưới **một user hệ thống riêng** (`na_<slug>`) + **systemd
service riêng** + **cổng nội bộ riêng** (127.0.0.1:3000-3999, không public) —
cô lập hoàn toàn giữa các app, nginx chỉ đóng vai trò reverse-proxy phía trước.

- ✅ Quản lý domain (thêm/xoá) + domain phụ (alias) trỏ vào cùng app
- 🔒 SSL miễn phí qua **certbot** (phát hành / gia hạn / thu hồi)
- 🗄️ Tạo sẵn **database MariaDB** + **Redis DB riêng (0-15)** cho từng app (tùy chọn)
- 👤 Mỗi app một **user Linux riêng**, systemd service riêng, thư mục riêng (750/640, `.env` 600)
- 🌐 nginx reverse-proxy tự sinh, hỗ trợ **Cloudflare real-IP** (trích xuất đúng IP client thật)
- 🧱 **UFW**: mặc định deny, mở SSH + 80/443 công khai (tùy chọn khoá origin theo dải IP Cloudflare với `--restrict-cloudflare`)
- 🛑 **Hardening nginx** (`napp nginx harden`): chặn truy cập thẳng IP / Host lạ (trả 444), chỉ domain đã cấu hình mới vào được; ẩn phiên bản nginx
- 🛡️ **fail2ban**: sshd + nginx-botsearch/http-auth/limit-req + jail riêng chống spam 502/504/429
- 💾 **Backup định kỳ** (database + mã nguồn) qua **systemd timer**, có xoay vòng retention
- ⚙️ **Tối ưu theo phần cứng thực tế**: `napp tune apply` phát hiện CPU/RAM và điều chỉnh nginx/MariaDB/Redis/sysctl **và NODE_OPTIONS heap V8 cho từng app node** — chạy lại bất cứ khi nào nâng cấp server
- 🔍 `napp check --fix`: kiểm tra + tự cài Node.js, nginx, certbot, MariaDB, Redis, fail2ban, UFW nếu thiếu
- 🩺 **`napp doctor`**: soi **bản vá bảo mật đang chờ** (nginx, OpenSSL, OpenSSH…), dịch vụ còn chạy **thư viện cũ** sau khi vá, đối chiếu **CVE nổi bật của nginx**, vòng đời Node.js; quét **rủi ro chuỗi cung ứng** (dependency chain attack) trong dependencies của từng app/service — và `napp doctor upgrade` để lấy bản vá về
- 🔄 Tự cập nhật (`napp update`) qua gist công khai, giống lara
- 🇻🇳 Toàn bộ output tiếng Việt, menu tương tác dạng số
- 💻 Hệ điều hành: **Ubuntu 20.04 – 26.04 LTS**

---

## 🚀 Cài đặt nhanh (một lệnh)

Chạy trên server mới (cần quyền sudo/root):

```bash
curl -fsSL "https://gist.githubusercontent.com/anhtuank7c/cc1e8194608e3f5a942d6d1d6669e6a3/raw/install.sh" | sudo bash
```

Script sẽ tự cài Node.js (qua NodeSource) nếu máy chưa có, rồi cài `napp` vào
`/usr/local/bin/napp`. Xong, giờ gõ `sudo napp` ở bất cứ đâu để mở menu.

> ⚠️ Trước khi dùng thật, hãy đăng `dist/napp.cjs` + `install.sh` lên một gist
> **công khai** của bạn và sửa `<GIST_ID>` ở trên (xem mục [Tự lưu trữ / OTA
> update](#-tự-lưu-trữ-gist--ota-update) bên dưới).

---

## ✅ Kiểm tra môi trường trước khi dùng

```bash
sudo napp check          # chỉ kiểm tra, không thay đổi gì
sudo napp check --fix    # tự cài/khởi động các thành phần còn thiếu
```

`napp` cần: **Node.js**, **sudo**, **git**, **nginx**. Tùy chọn: **MariaDB**
(nếu dùng `--db`), **Redis** (nếu dùng `--redis`), **certbot + plugin nginx**
(nếu dùng SSL), **fail2ban**, **UFW**. Lệnh `check` sẽ chỉ rõ thứ còn thiếu.

---

## 📖 Cách dùng

### Menu tương tác (khuyến nghị cho người mới)

```bash
sudo napp
```

Gõ số rồi Enter, `0` để quay lại/thoát.

### Hoặc dùng lệnh trực tiếp

| Lệnh | Tác dụng |
| --- | --- |
| `sudo napp check [--fix]` | Kiểm tra / tự cài môi trường máy chủ |
| `sudo napp doctor [--deep]` | **Soi bảo mật**: bản vá đang chờ + rủi ro dependencies của mọi app/service |
| `sudo napp doctor system` | Chỉ kiểm tra bản vá hệ thống, dịch vụ còn nạp thư viện cũ, CVE nginx, EOL Node.js |
| `sudo napp doctor deps [<domain\|name>]` | Chỉ quét rủi ro chuỗi cung ứng của dependencies |
| `sudo napp doctor upgrade [--all] [--only nginx] [-y]` | Cài bản vá (mặc định chỉ bản vá **bảo mật**) + restart dịch vụ liên quan |
| `sudo napp app create <domain> [--repo <url>] [--branch <b>] [--runtime node\|bun] [--db] [--redis] [--port <n>] [--env K=V...]` | Tạo app mới |
| ↳ `[--app-dir apps/backend]` | Monorepo: app nằm trong thư mục con (WorkingDirectory + `.env` trỏ vào đó) |
| ↳ `[--static-root <dir> --static-prefix /_app/]` | Cho **nginx** trả asset build thay vì Node |
| ↳ `[--upload-dir <dir>]` | Thư mục file **tải lên lúc chạy** — không phải asset build, xem cảnh báo dưới |
| ↳ `[--hotlink-protect]` `[--hotlink-allow <domain>]` | Chỉ cho nhúng ảnh từ domain của site |
| ↳ `[--max-body 100M]` | `client_max_body_size` (mặc định `20M`) |
| ↳ `[--share-redis-with <domain>]` \| `[--redis-db <n>]` | Dùng **chung** Redis DB với đơn vị khác |
| `sudo napp app deploy <domain>` | git pull + cài deps + build + restart |
| `sudo napp app set <domain> [--static-root <dir>] [--static-prefix /_app/] [--upload-dir <dir>] [--hotlink-protect] [--max-body 100M]` | **Đổi cấu hình nginx của app ĐÃ TẠO** — giữ nguyên khối SSL của certbot |
| `sudo napp app list` | Liệt kê app đang quản lý |
| `sudo napp app restart\|stop\|start <domain>` | Điều khiển service |
| `napp app logs <domain> [-f] [-n 200]` | Xem log (journalctl) |
| `sudo napp app env-set <domain> KEY=VALUE...` | Cập nhật `.env` |
| `sudo napp app remove <domain> [-y]` | Gỡ app — mặc định xoá nginx + ssl, GIỮ mã nguồn + database |
| `sudo napp app remove <domain> --all` | Gỡ app + xoá tất cả (nginx, ssl, mã nguồn, database) |
| `sudo napp app remove <domain> --source --db` | Xoá thêm mã nguồn và/hoặc database (`--keep-nginx`/`--keep-ssl` để giữ) |
| `sudo napp service create <name> [--repo <url>] [--start-cmd <cmd>] [--runtime node\|bun] [--db] [--redis] [--port <n>] [--env K=V...]` | Tạo **background service** (chạy ngầm, không domain/nginx) |
| ↳ `[--share-redis-with <domain>]` | **Bắt buộc** nếu service tiêu thụ hàng đợi của một web app |
| ↳ `[--run-as <domain>]` | Chạy bằng **user của app web đã có** — bắt buộc nếu worker đọc/ghi FILE của app đó |
| ↳ `[--write-dir <path>]` | Cấp thêm quyền GHI vào đường dẫn ngoài mã nguồn service (lặp lại được) |
| ↳ `[--app-dir apps/worker]` | Monorepo: worker nằm trong thư mục con |
| `sudo napp service set <name> [--run-as <domain>\|--standalone] [--write-dir <path>]` | Đổi **danh tính/quyền ghi** của service đã tạo |
| `sudo napp service deploy <name>` | git pull + cài deps + build + restart service |
| `sudo napp service list` | Liệt kê background service đang quản lý |
| `sudo napp service restart\|stop\|start <name>` | Điều khiển service |
| `napp service logs <name> [-f] [-n 200]` | Xem log (journalctl) |
| `sudo napp service env-set <name> KEY=VALUE...` | Cập nhật `.env` |
| `sudo napp service remove <name> [-y] [--source] [--db] [--all]` | Gỡ service — mặc định GIỮ mã nguồn + database |
| `sudo napp domain add\|remove <domain> <alias>` | Domain phụ trỏ vào app |
| `sudo napp cert issue <domain> --email <email> [--no-www] [--no-redirect] [--extra <d>]` | Phát hành SSL (không tương tác; nhớ email cho lần sau) |
| `sudo napp cert renew [<domain>] [--force]` | Gia hạn SSL |
| `sudo napp cert revoke <domain>` / `list` / `status` | Thu hồi / liệt kê / trạng thái SSL |
| `sudo napp db create\|drop\|backup <name>` / `list` | Database độc lập (ngoài `--db` của app) |
| `napp redis info\|allocations` / `sudo napp redis flush <n>` | Quản lý Redis |
| `sudo napp backup run [--target db\|files\|all] [--database <name>] [--keep-days n]` | Backup ngay (nén gzip; chọn 1 DB hoặc tất cả) |
| `sudo napp backup schedule --time 03:00 --keep-days 14` | Lên lịch backup hàng ngày (retention theo ngày) qua systemd timer |
| `sudo napp backup list` / `unschedule` | Danh sách backup (kèm dung lượng) / gỡ lịch |
| `sudo napp firewall sync [--ssh-port n] [--restrict-cloudflare]` | Đồng bộ UFW (mặc định mở 80/443; `--restrict-cloudflare` để khoá origin theo IP Cloudflare) |
| `sudo napp fail2ban setup` | Áp cấu hình fail2ban |
| `sudo napp nginx harden` / `unharden` | Chặn truy cập IP/Host lạ (default_server 444) + ẩn version / gỡ |
| `sudo napp cloudflare sync` | Đồng bộ dải IP Cloudflare vào nginx (real IP) ngay |
| `sudo napp cloudflare schedule [--time 01:00]` | Lên lịch tự động đồng bộ IP Cloudflare (systemd timer, hàng ngày) |
| `sudo napp cloudflare unschedule` | Gỡ lịch tự động đồng bộ IP Cloudflare |
| `sudo napp tune show\|apply` | Xem/áp tối ưu theo phần cứng thực tế |
| `sudo napp update` | Tự cập nhật napp lên bản mới nhất |
| `napp version` / `changelog` | Phiên bản / lịch sử thay đổi |
| `sudo napp install` / `uninstall` | Cài/gỡ napp khỏi `/usr/local/bin` |

> 💡 Thêm `--dry-run` vào **bất kỳ lệnh nào** để chạy thử (chỉ in ra các bước,
> không thay đổi gì thật). Thêm `--verbose` để in chi tiết lệnh hệ thống.

---

## 🌱 Ví dụ: tạo một app Node.js kèm database + Redis + SSL

```bash
sudo napp app create api.example.com \
  --repo git@github.com:you/api.git \
  --branch main \
  --install-cmd "npm ci --omit=dev" \
  --build-cmd "npm run build" \
  --start-cmd "node dist/server.js" \
  --db --redis
```

- Tạo user hệ thống `na_api_example_com`, clone repo, cài deps, build
- Tạo `/var/www/api.example.com`, systemd service `napp-api_example_com`, vhost nginx (HTTP)
- Tạo sẵn database + user MariaDB, cấp một Redis DB riêng, ghi hết vào `.env`

**Repo private?** napp không hỏi mật khẩu tương tác (tránh treo) — truyền xác thực ngay khi tạo:

```bash
# HTTPS + Personal Access Token
sudo napp app create api.example.com \
  --repo https://github.com/you/api.git --token ghp_xxx

# SSH + deploy key
sudo napp app create api.example.com \
  --repo git@github.com:you/api.git --ssh-key /root/deploy_key
```

Token/deploy key được lưu vào home của user app (quyền `600`) nên `napp app deploy` các lần sau cũng không hỏi lại.

Trỏ bản ghi DNS A của domain về server (bật proxy Cloudflare nếu dùng), rồi bật HTTPS:

```bash
sudo napp cert issue api.example.com --email ban@example.com
```

Xem log:

```bash
sudo napp app logs api.example.com -f
```

Deploy bản mới sau khi push code:

```bash
sudo napp app deploy api.example.com
```

---

## ⚙️ Ví dụ: background service chạy ngầm (worker / bot / queue consumer)

Không phải chương trình Node.js nào cũng có domain. Worker xử lý hàng đợi, bot
Telegram/Discord, cron poller… chạy NGẦM, không cần nginx/SSL/cổng. Dùng nhóm
lệnh `napp service` — vẫn có user riêng, systemd (hardening + tự restart),
tuỳ chọn `--db`/`--redis`, clone repo private y như app web, chỉ khác là **không
domain, không nginx**.

```bash
# Worker xử lý hàng đợi (không listen cổng nào)
sudo napp service create queue-email \
  --repo git@github.com:you/worker.git \
  --start-cmd "node src/index.js" \
  --db --redis

# Bot Telegram, dùng bun
sudo napp service create bot-telegram \
  --repo git@github.com:you/bot.git \
  --runtime bun --start-cmd "bun run start"

# Service tự bind một cổng nội bộ (health-check) — vẫn KHÔNG public qua nginx
sudo napp service create metrics-agent --port 3500 --start-cmd "node agent.js"
```

- Tạo user hệ thống `nas_<name>`, mã nguồn ở `/var/www/<name>-service`, systemd
  `napp-svc-<name>` (namespace tách biệt với app web).

### Worker đụng vào FILE của một app web — `--run-as`

Worker nén ảnh, sinh thumbnail hay dọn cache **trong thư mục của app web** thì
user riêng không dùng được: thư mục app là `750`, file `640`, thuộc user của app
— user khác đọc còn không nổi. Nới quyền thư mục ra cho hai user là mở luôn cho
mọi thứ khác trên máy. Cách đúng là cho worker **chạy bằng chính user của app**:

```bash
sudo napp app create shop.example.com --repo ... --redis
sudo napp service create shop-images \
  --repo git@github.com:you/image-worker.git \
  --run-as shop.example.com \
  --share-redis-with shop.example.com \
  --start-cmd "node compress.js"
```

`--run-as` làm hai việc, và **thiếu một trong hai là hỏng**:

| Lớp chặn | Triệu chứng khi thiếu | `--run-as` xử lý |
|---|---|---|
| Quyền Unix (`750`/`640` của user app) | `EACCES` | `User=`/`Group=` của unit là user app |
| Sandbox systemd (`ProtectSystem=strict`) | `EROFS` dù `ls -l` trông đúng quyền | Thêm thư mục app vào `ReadWritePaths=` |

Cần ghi vào chỗ **khác** nữa (thư mục dùng chung, kho ảnh ngoài `/var/www`) thì
thêm `--write-dir /đường/dẫn` — lặp lại được. Đường dẫn phải **tồn tại sẵn**:
systemd từ chối khởi động unit nếu `ReadWritePaths` trỏ vào chỗ không có, và
thông báo lỗi lúc đó (`Failed to set up mount namespacing`) không hề nói đường
dẫn nào sai.

> **Đánh đổi: mất cô lập.** Worker và app web là **cùng một danh tính Unix** —
> worker đọc/ghi được mọi thứ của app, kể cả `.env` (mật khẩu DB, khoá API), và
> ngược lại. Một bên bị chiếm quyền là bên kia mất theo. Chỉ dùng khi hai bên là
> hai nửa của **cùng một sản phẩm**; worker độc lập (bot, cron poller, worker
> của sản phẩm khác) thì **bỏ `--run-as`** để giữ user riêng — đó vẫn là mặc định.
>
> Đổi lại, napp **không bao giờ xoá user đi mượn**: `napp service remove --source`
> giữ nguyên user, và `napp app remove --source` từ chối xoá user khi còn worker
> đang mượn (kèm danh sách worker cần gỡ trước).

Nhu cầu này thường lộ ra **sau** khi worker đã chạy được vài tuần, nên không phải
xoá đi tạo lại:

```bash
sudo napp service set shop-images --run-as shop.example.com   # mượn user app web
sudo napp service set shop-images --standalone                # quay về user riêng
sudo napp service set shop-images --write-dir /mnt/media      # đặt lại danh sách ghi thêm
```

Lệnh này `chown` lại mã nguồn sang user mới, ghi lại unit và restart service.

> **Worker của một web app phải dùng CHUNG Redis DB với web app đó.** `--redis`
> cấp cho mỗi đơn vị một DB riêng — đúng với hai sản phẩm khác nhau, sai với hai
> nửa của cùng một sản phẩm. Hàng đợi chỉ chạy khi bên đẩy việc và bên tiêu thụ
> nhìn cùng một keyspace; khác DB thì web đẩy job vào `#1` còn worker nghe `#2`,
> **không bên nào báo lỗi** và mọi việc nền lặng lẽ không bao giờ chạy:
>
> ```bash
> sudo napp app create shop.example.com --repo ... --redis
> sudo napp service create shop-worker  --repo ... --share-redis-with shop.example.com
> ```
>
> Ngoài Redis, hai bên còn phải khớp **mọi bí mật dùng chung** (khoá mã hoá,
> tiền tố hàng đợi/cache). napp không sinh những biến đó — truyền bằng `--env`
> với **cùng giá trị** cho cả hai.

> **File tải lên cần `--upload-dir`, không dùng `--static-root` được.** Với
> SvelteKit adapter-node (và tương tự), `static/` được **sao chép vào
> `build/client/` lúc build** và lúc chạy server chỉ phục vụ `build/client`. Ảnh
> admin tải lên **sau** khi build nằm ở `static/uploads`, không có trong
> `build/client`, nên trả **404 dù file có thật trên đĩa** — rồi tự nhiên hiện
> ra sau lần deploy kế tiếp vì build lại sao chép `static/`. Trông y như lỗi
> chập chờn:
>
> ```bash
> sudo napp app create pghotel.vn --repo ... \
>   --upload-dir /var/www/pghotel.vn/apps/backend/static/uploads
> ```

> **`--hotlink-protect` chặn hotlink TUỲ TIỆN, không phải kiểm soát truy cập.**
> `Referer` do trình duyệt tự khai — trang hotlink chỉ cần
> `<meta name="referrer" content="no-referrer">` là đi qua. Và nếu có CDN đứng
> trước, CDN cache theo URL và **không quan tâm `Referer`**: ảnh đã vào cache
> edge được trả cho mọi referer mà không hỏi origin, nên cấu hình này chỉ tác
> dụng với lần cache MISS — muốn chặn thật thì bật ở tầng CDN (Cloudflare có
> sẵn Hotlink Protection trong Scrape Shield). Đừng "chữa" bằng `Vary: Referer`,
> nó biến mỗi referer thành một bản cache riêng.
>
> `none` (không có `Referer`) được phép có chủ đích: bot lấy ảnh xem trước khi
> chia sẻ link — Facebook, Zalo, Telegram — thường không gửi `Referer`, chặn nó
> là **mọi link chia sẻ mất ảnh preview**.
- **Mọi mã nguồn nằm chung `/var/www`**: app web giữ tên domain
  (`/var/www/api.example.com`), service có hậu tố `-service`
  (`/var/www/queue-email-service`) — khỏi phân mảnh thư mục, dễ tìm. Nằm trong
  `/var/www` KHÔNG làm service public: nginx chỉ phục vụ những gì có vhost trỏ tới.
- **Lệnh khởi động tự do theo framework**: Express `node src/index.js`,
  SvelteKit adapter-node `node build/index.js`, worker `node worker.js`… đặt qua
  `--start-cmd` (mặc định `npm start` theo `package.json`).
- **Cổng là tuỳ chọn**: mặc định không cấp cổng; chỉ `--port` khi service tự bind.
- Heap V8 được chia chung với các app web để tổng RAM không bị vượt.

```bash
sudo napp service logs queue-email -f      # xem log
sudo napp service deploy queue-email       # git pull + rebuild + restart
sudo napp service remove queue-email       # gỡ (mặc định giữ mã nguồn + database)
```

---

## 🔐 Bảo mật mặc định

- Mỗi app: user Linux riêng (`nologin`), thư mục `750`, file `640`, `.env` `600`
- systemd service hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `ReadWritePaths` giới hạn đúng thư mục app
- Database: mỗi app một database + user CSDL riêng, quyền chỉ trên database đó (không dùng root)
- UFW: mặc định deny incoming, mở SSH + **80/443 công khai**. Việc lấy đúng IP client thật khi qua Cloudflare do nginx real-IP đảm nhiệm (`napp cloudflare sync`), độc lập với tường lửa. Nếu muốn khoá origin chỉ nhận traffic từ dải IP Cloudflare (chống bypass thẳng origin IP) thì thêm `--restrict-cloudflare` — lưu ý mọi domain phải bật proxy Cloudflare
- fail2ban: chặn brute-force SSH + bot dò nginx + IP spam lỗi 502/504/429
- Cloudflare real-IP: nginx trích xuất đúng IP client thật (không phải IP edge Cloudflare) để app phía sau nhận `X-Real-IP`/`X-Forwarded-For` chính xác

⚠️ **An toàn khi chạy `napp firewall sync` lần đầu**: hãy giữ một phiên
SSH/console **thứ hai** đang mở song song — nếu cổng SSH bị dò sai hoặc UFW
cấu hình nhầm, phiên hiện tại có thể bị khoá ngay lập tức.

---

## 🩺 Soi bảo mật: `napp doctor`

`napp check` trả lời *"môi trường đã ĐỦ chưa"*. `napp doctor` trả lời *"môi
trường có ĐANG AN TOÀN không"* — hai việc khác nhau.

```bash
sudo napp doctor                 # quét tất cả: bản vá hệ thống + dependencies mọi app/service
sudo napp doctor system          # chỉ phần hệ thống
sudo napp doctor deps            # chỉ phần dependencies
sudo napp doctor deps api.example.com    # một app cụ thể (hoặc tên service)
sudo napp doctor upgrade         # LẤY BẢN VÁ VỀ: cài bản vá bảo mật + restart dịch vụ
```

### Phần hệ thống (`doctor system`)

| Kiểm tra | Vì sao quan trọng |
| --- | --- |
| **Bản vá bảo mật đang chờ** | Đọc từ apt (`-security`), đánh dấu `!` cho gói trọng yếu: nginx, OpenSSL, OpenSSH, libc, MariaDB, Redis, Node.js, certbot… |
| **Dịch vụ còn nạp thư viện CŨ** | Cái bẫy kinh điển: `apt upgrade` xong tưởng đã an toàn, nhưng nginx vẫn giữ `libssl` cũ **trong RAM** cho tới khi restart. napp đọc `/proc/<pid>/maps` tìm thư viện `(deleted)` — không cần cài thêm gói nào |
| **CVE nổi bật của nginx** | Đối chiếu bảng CVE kèm theo (CVE-2021-23017 RCE qua resolver, HTTP/2 Rapid Reset, mp4 module, mTLS session resumption…) rồi **kết luận bằng bằng chứng trên máy**: `[ĐÃ VÁ]` / `[KHÔNG DÍNH]` / mức độ cần chú ý |
| **Vòng đời Node.js** | Bản EOL **không còn nhận bản vá nào nữa** — rủi ro lớn hơn một CVE lẻ vì vĩnh viễn không được sửa |
| **Cần khởi động lại máy** | `/var/run/reboot-required` sau khi vá kernel/libc |

#### Vì sao không chỉ so số phiên bản

Ubuntu/Debian **vá ngược (backport)** mà giữ nguyên số phiên bản upstream:
`nginx 1.24.0` đã vá và chưa vá **nhìn giống hệt nhau**. Một công cụ chỉ so số
sẽ báo động mãi không tắt kể cả sau khi bạn đã `apt upgrade` — vô dụng, và còn
tệ hơn không có vì bạn sẽ học cách phớt lờ nó.

Nên `doctor` kết luận từng CVE bằng **bằng chứng đọc được ngay trên máy**, theo
thứ tự tin cậy giảm dần:

| Kết luận | Căn cứ |
| --- | --- |
| `[ĐÃ VÁ]` | Mã CVE **có trong changelog của gói đã cài** (`/usr/share/doc/nginx-*/changelog.Debian.gz`) — bản vá backport luôn ghi mã CVE vào đây. Đây là bằng chứng chắc chắn nhất, đọc offline, không cần mạng |
| `[KHÔNG DÍNH]` | Module chứa lỗ hổng **không được biên dịch vào** (`nginx -V`), hoặc cấu hình đang chạy **không kích hoạt** phần đó (`nginx -T`): không có `mp4`, không bật HTTP/2, không có `resolver`, không dùng `ssl_verify_client`… |
| `[CAO]` / `[NGHIÊM TRỌNG]` | Không chứng minh được là đã xử lý — kèm dòng *"vì sao còn nằm đây"* để bạn biết còn thiếu bằng chứng nào |

Chạy bằng `sudo` thì đọc được `nginx -T`, nên kết luận đầy đủ hơn hẳn. Lưu ý
`[KHÔNG DÍNH]` dựa trên cấu hình **tại thời điểm quét** — bật HTTP/2 hay thêm
`resolver` sau đó thì phải quét lại. Bảng CVE nằm trong binary nên hãy chạy
`napp update` để có bảng mới nhất.

**Tự kiểm chứng bằng tay:**

```bash
dpkg-query -W -f='${Version}\n' nginx-core nginx-common   # phiên bản GÓI (vd 1.24.0-2ubuntu7.5) — con số thật sự phản ánh mức vá
zgrep -i 'CVE-2023-44487' /usr/share/doc/nginx-common/changelog.Debian.gz   # có ghi = đã backport bản vá
apt changelog nginx | head -40                            # xem toàn bộ lịch sử vá của gói
```

Hoặc tra trên trang chính thức: `https://ubuntu.com/security/CVE-2023-44487` —
trang này ghi rõ mỗi bản Ubuntu đã vá ở **phiên bản gói nào**, đối chiếu với số
`dpkg-query` ở trên là biết chắc.

### Phần dependencies (`doctor deps`)

Nhắm đúng kịch bản **dependency chain attack**: kẻ xấu chiếm tài khoản npm của
một thư viện, đẩy bản vá nhỏ có mã độc; app dùng dải phiên bản mở và không có
lockfile nên lần deploy kế tiếp tự kéo bản độc về, rồi `postinstall` chạy ngay
với quyền user của app.

| Dấu hiệu | Mức | Cách xử lý napp gợi ý |
| --- | --- | --- |
| Thiếu **lockfile** | CAO | Sinh + **commit** lockfile — bản ghi chính xác từng phiên bản kèm hash toàn vẹn |
| Dependency `*` / `latest` | CAO | Ghim phiên bản cụ thể |
| Dependency trỏ thẳng **git/URL** | CAO | Không có hash toàn vẹn — ghim theo commit SHA đầy đủ |
| Tên **gần giống** package phổ biến (typosquat) | CAO | Đối chiếu tên chính thức; nếu đã cài nhầm thì đổi toàn bộ secret |
| **Lỗ hổng đã công bố** (`npm/pnpm/yarn/bun audit`) | tuỳ mức | Nâng cấp, commit lockfile mới, deploy lại |
| Package chạy **script khi cài** | TB/THẤP | Rà danh sách; chặn hẳn bằng `--install-cmd '... --ignore-scripts'` |
| `.npmrc` chứa token, quyền quá rộng | CAO | `chmod 600` |
| Bản phát hành **quá mới** (`--deep`) | TB | Gói bị chiếm thường chỉ sống vài giờ–vài ngày trên registry trước khi bị gỡ — đáng dừng lại kiểm tra changelog |

`--deep` tra thêm ngày phát hành của **dependency trực tiếp** trên registry npm
(cần mạng, giới hạn 40 gói/dự án để không biến việc quét thành trận tải lớn).

### Lấy bản vá về (`doctor upgrade`)

```bash
sudo napp doctor upgrade              # chỉ bản vá BẢO MẬT (khuyến nghị)
sudo napp doctor upgrade --only nginx # chỉ nginx và các gói nginx-*
sudo napp doctor upgrade --all        # mọi bản cập nhật đang chờ
sudo napp doctor upgrade -y --no-restart   # cài, tự quyết định lúc nào restart
```

Lệnh này giữ **an toàn cho cấu hình đang chạy**: dùng
`--force-confold` nên dpkg **không ghi đè** file cấu hình hiện có và không dừng
lại hỏi tương tác; nếu có nâng cấp nginx thì chạy `nginx -t` **trước khi**
restart — cấu hình sai thì dừng lại thay vì làm sập site. Sau khi cài, napp tìm
đúng những dịch vụ còn nạp thư viện cũ và chỉ restart bấy nhiêu đó.

Nếu bản phân phối đã hết hỗ trợ và không còn phát hành bản vá nginx nữa, napp sẽ
gợi ý nâng cấp OS hoặc chuyển sang [kho chính thức nginx.org](https://nginx.org/en/linux_packages.html).

---

## ⚙️ Tối ưu theo phần cứng

```bash
sudo napp tune show    # xem phần cứng phát hiện được + kế hoạch (chưa áp dụng)
sudo napp tune apply    # áp: nginx worker/gzip, MariaDB innodb_buffer_pool, Redis maxmemory, sysctl,
                        # và NODE_OPTIONS heap cho từng app node (ghi lại unit + restart app)
```

Chạy `napp tune apply` **bất cứ khi nào nâng cấp phần cứng server** (thêm
RAM/CPU) để tự động tính lại và áp cấu hình phù hợp — không cần tính tay.

> **Redis `maxmemory-policy` = `noeviction`.** BullMQ kiểm tra ngay lúc kết nối
> và báo `IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"`.
> Dữ liệu hàng đợi không phải cache: khi chạm `maxmemory`, chính sách `*-lru`
> cho phép Redis **tự trục xuất key** và job bốc hơi giữa chừng mà không bên nào
> báo lỗi (`volatile-lru` cũng không thoát — BullMQ có đặt TTL cho khoá, rate
> limit và job đã hoàn tất). `noeviction` khiến Redis **từ chối lệnh ghi** khi
> đầy, hỏng lộ liễu thay vì mất việc trong im lặng. Chính sách này áp cho **cả
> instance**, không tách theo DB index, nên hãy đặt TTL cho key cache của app và
> theo dõi `napp redis info`.
>
> Server đã chạy `napp tune apply` bằng bản napp **cũ hơn 1.18.0** đang để
> `volatile-lru`. `napp check` nay phát hiện việc này; sửa bằng một trong hai:
>
> ```bash
> sudo napp check --fix    # áp ngay, không restart Redis
> sudo napp tune apply     # sinh lại toàn bộ cấu hình (có restart Redis)
> ```

---

## 🔄 Tự lưu trữ Gist + OTA update

Để `napp update` hoạt động (giống `lara update`):

1. Build: `npm install && npm run build` → ra `dist/napp.cjs`
2. Tạo một **gist công khai** trên GitHub chỉ chứa `napp.cjs` (và tùy chọn `install.sh`)
3. Lấy URL "raw" **không kèm SHA commit** (luôn trỏ tới bản mới nhất), dạng:
   `https://gist.githubusercontent.com/<user>/<gist-id>/raw/napp.cjs`
4. Sửa `NAPP_UPDATE_URL_DEFAULT` trong `src/version.ts` (và `NAPP_CJS_URL_DEFAULT`
   trong `install.sh`) thành URL thật, build lại, rồi cập nhật lại chính gist đó.

Từ lần sau, mỗi khi sửa code + build lại + cập nhật gist, chạy trên mọi server:

```bash
sudo napp update
```

`napp update` tải file mới về **tạm thời trước**, kiểm tra cú pháp hợp lệ +
đúng là `napp.cjs` (qua marker phiên bản), rồi mới cài đè — không bao giờ
dùng kiểu `curl | bash` để cài trực tiếp bản chưa kiểm chứng.

---

## 🏗️ Phát triển

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild -> dist/napp.cjs (một file duy nhất, có shebang)
node dist/napp.cjs --help
```

Cấu trúc:

```
src/
  index.ts              # CLI entry (commander)
  version.ts             # version + changelog + URL update
  lib/                    # log, exec (dry-run/run-as), state (registry JSON),
                          # validate, hardware, lock, mysql, envfile, cloudflare, network
  templates/              # nginx, systemd (service/timer), fail2ban, tuning
  commands/               # check, app, domain, cert, db, redis, backup,
                          # firewall, fail2ban, tune, cloudflare, update, menu, installSelf
```

Registry trạng thái (danh sách app, cổng đã cấp, Redis DB đã cấp) lưu tại
`/etc/napp/state.json`.

---

## 🔄 Cập nhật & gỡ cài

```bash
sudo napp update       # lên bản mới nhất (tải từ gist)
sudo napp uninstall    # gỡ napp — các app hiện có vẫn được giữ nguyên
```

---

> ⚠️ Luôn chạy `napp` bằng `sudo`/root cho các thao tác quản trị. Mỗi app
> chạy dưới user hệ thống riêng (`na_<domain>`) để đảm bảo cô lập giữa các app.

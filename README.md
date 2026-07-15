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
- 🛡️ **fail2ban**: sshd + nginx-botsearch/http-auth/limit-req + jail riêng chống spam 502/504/429
- 💾 **Backup định kỳ** (database + mã nguồn) qua **systemd timer**, có xoay vòng retention
- ⚙️ **Tối ưu theo phần cứng thực tế**: `napp tune apply` phát hiện CPU/RAM và điều chỉnh nginx/MariaDB/Redis/sysctl **và NODE_OPTIONS heap V8 cho từng app node** — chạy lại bất cứ khi nào nâng cấp server
- 🔍 `napp check --fix`: kiểm tra + tự cài Node.js, nginx, certbot, MariaDB, Redis, fail2ban, UFW nếu thiếu
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
| `sudo napp app create <domain> [--repo <url>] [--branch <b>] [--runtime node\|bun] [--db] [--redis] [--port <n>] [--env K=V...]` | Tạo app mới |
| `sudo napp app deploy <domain>` | git pull + cài deps + build + restart |
| `sudo napp app list` | Liệt kê app đang quản lý |
| `sudo napp app restart\|stop\|start <domain>` | Điều khiển service |
| `napp app logs <domain> [-f] [-n 200]` | Xem log (journalctl) |
| `sudo napp app env-set <domain> KEY=VALUE...` | Cập nhật `.env` |
| `sudo napp app remove <domain> [--keep-db] [-y]` | Xoá app |
| `sudo napp domain add\|remove <domain> <alias>` | Domain phụ trỏ vào app |
| `sudo napp cert issue <domain> --email <email> [--no-www] [--no-redirect] [--extra <d>]` | Phát hành SSL (không tương tác; nhớ email cho lần sau) |
| `sudo napp cert renew [<domain>] [--force]` | Gia hạn SSL |
| `sudo napp cert revoke <domain>` / `list` / `status` | Thu hồi / liệt kê / trạng thái SSL |
| `sudo napp db create\|drop\|backup <name>` / `list` | Database độc lập (ngoài `--db` của app) |
| `napp redis info\|allocations` / `sudo napp redis flush <n>` | Quản lý Redis |
| `sudo napp backup run [--target db\|files\|all] [--keep n]` | Backup ngay |
| `sudo napp backup schedule --time 03:00 --keep 7` | Lên lịch backup qua systemd timer |
| `sudo napp firewall sync [--ssh-port n] [--restrict-cloudflare]` | Đồng bộ UFW (mặc định mở 80/443; `--restrict-cloudflare` để khoá origin theo IP Cloudflare) |
| `sudo napp fail2ban setup` | Áp cấu hình fail2ban |
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

## ⚙️ Tối ưu theo phần cứng

```bash
sudo napp tune show    # xem phần cứng phát hiện được + kế hoạch (chưa áp dụng)
sudo napp tune apply    # áp: nginx worker/gzip, MariaDB innodb_buffer_pool, Redis maxmemory, sysctl,
                        # và NODE_OPTIONS heap cho từng app node (ghi lại unit + restart app)
```

Chạy `napp tune apply` **bất cứ khi nào nâng cấp phần cứng server** (thêm
RAM/CPU) để tự động tính lại và áp cấu hình phù hợp — không cần tính tay.

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

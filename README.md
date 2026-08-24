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
- ⚡ **Asset tĩnh do nginx trả thẳng** (`--auto-static`): napp nhận diện framework từ **thư mục build** (SvelteKit · Next.js · Nuxt · SolidStart · Astro · Remix · Vite), chọn đúng `root`/`alias` và tự cấp quyền đọc cho nginx — thay vì để hàng trăm chunk `.js`/`.css` xếp hàng trên event loop đơn luồng của Node
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

Ngoài thành phần còn thiếu, `check` còn soi **cấu hình đã lỗi thời hoặc chưa
bật** trên các app ĐANG CHẠY — những thứ không có lệnh nào tự phát hiện giúp:

| Phát hiện | Vì sao đáng quan tâm |
|---|---|
| Redis `maxmemory-policy` khác `noeviction` | BullMQ mất job giữa chừng, không bên nào báo lỗi |
| Vhost còn bộ đệm proxy `16k` nội tuyến | Route SvelteKit lồng sâu trả 502 |
| App còn đẩy **toàn bộ asset tĩnh** qua Node | App chậm mà **không có lỗi nào để lần ra** |
| nginx **không đọc được** thư mục asset đã cấu hình | Asset trả **403** chứ không phải file |
| Thư mục tải lên trong gốc tĩnh công khai chưa được phục vụ | File tải lên sau lần build gần nhất trả **404**, rồi tự hiện ra sau deploy — giống lỗi chập chờn |

`--fix` sửa được cả năm (trừ tiền tố `/assets/` rủi ro — xem phần asset tĩnh).

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
| ↳ `[--auto-static]` | **Nhận diện framework từ thư mục build** rồi cho nginx trả thẳng asset (SvelteKit · Next.js · Nuxt · SolidStart · Astro) |
| ↳ `[--static-root <dir> --static-prefix /_app/]` | Cho **nginx** trả asset build thay vì Node (cấu hình tay) |
| ↳ `[--static-alias /_next/static/=<dir>]` | Như trên nhưng khi **URL khác tên thư mục trên đĩa** (Next.js) |
| ↳ `[--upload-dir <dir>]` | Thư mục file **tải lên lúc chạy** — không phải asset build, xem cảnh báo dưới |
| ↳ `[--hotlink-protect]` `[--hotlink-allow <domain>]` | Chỉ cho nhúng ảnh từ domain của site |
| ↳ `[--max-body 100M]` | `client_max_body_size` (mặc định `20M`) |
| ↳ `[--share-redis-with <domain>]` \| `[--redis-db <n>]` | Dùng **chung** Redis DB với đơn vị khác |
| `sudo napp app deploy <domain>` | git pull + cài deps + build + restart |
| `sudo napp app set <domain> --auto-static` | **Bật asset tĩnh cho app ĐÃ TẠO** — napp tự nhận diện framework và tự cấp quyền đọc cho nginx |
| `sudo napp app set <domain> [--static-root <dir>] [--static-prefix /_app/] [--static-alias <p>=<dir>] [--upload-dir <dir>] [--hotlink-protect] [--max-body 100M]` | **Đổi cấu hình nginx của app ĐÃ TẠO** — giữ nguyên khối SSL của certbot |
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
| `sudo napp nginx sync` | Đồng bộ cấu hình proxy dùng chung vào các vhost đã có (bộ đệm, header `Connection`) — **giữ nguyên khối SSL của certbot** |
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

## ⚡ Asset tĩnh: cho nginx trả thẳng thay vì đẩy qua Node

Mặc định vhost không có `root` nào, nên **mọi** file — từng chunk `.js`, `.css`,
`.woff2` — đều đi qua tiến trình Node. Một trang SSR/SPA hiện đại kéo hàng trăm
chunk, tất cả xếp hàng trên **event loop đơn luồng** và tranh chấp với chính
việc render trang.

Đây là loại hỏng **không có triệu chứng nào để lần ra**: không log, không lỗi,
không mã trạng thái lạ. App chỉ đơn giản là chậm, người dùng mô tả là "vào
dashboard thấy giựt" rồi đi đo CPU/RAM — nơi mọi thứ trông hoàn toàn bình thường.

### Cách nhanh nhất: để napp tự nhận diện

```bash
# App đã tạo từ trước
sudo napp app set demo.example.com --auto-static

# Hoặc ngay lúc tạo app
sudo napp app create demo.example.com --repo ... --build-cmd "npm run build" --auto-static
```

`napp check` cũng tự báo app nào còn đẩy toàn bộ asset qua Node, và `napp check
--fix` bật giúp:

```
- [nginx-static] 2 app đang đẩy TOÀN BỘ asset tĩnh qua tiến trình Node
  (demo.example.com: SvelteKit (adapter-node), shop.example.com: Next.js)...
```

### Cấu hình tay

```bash
# SvelteKit / Nuxt / Astro / SolidStart — URL trùng tên thư mục -> dùng root
sudo napp app set demo.example.com \
  --static-root /var/www/demo.example.com/build/client --static-prefix /_app/

# Next.js — URL khác tên thư mục -> phải dùng alias
sudo napp app set shop.example.com \
  --static-alias /_next/static/=/var/www/shop.example.com/.next/static
```

`--static-prefix` và `--static-alias` đều **lặp lại được**.

napp **cố ý chỉ phục vụ theo tiền tố đã khai báo**, không dùng `try_files $uri`
chung cho `location /`: một `try_files` chung sẽ đem cả cây thư mục ra đường (kể
cả file lọt vào đó ngoài ý muốn) và có thể trả `index.html` tĩnh thay vì để app
tự render.

### Những cái bẫy đã được mã hoá sẵn trong bảng luật

> **`--auto-static` nhận diện framework từ THƯ MỤC BUILD, không phải từ
> `package.json`.** Deps ở gốc repo không nói được app con đang dùng adapter
> nào (monorepo liệt kê cả `next` lẫn `@sveltejs/kit`), và cùng một app
> SvelteKit thì `adapter-node` sinh `build/client` còn `adapter-static` sinh
> `build` — deps giống hệt nhau. Hệ quả: **chỉ nhận diện được sau khi build**.
> Chưa build thì không có gì trên đĩa để phục vụ, và napp trả về "không nhận ra"
> thay vì đoán bừa.
>
> | Thấy trên đĩa | Framework | Tiền tố nginx chiếm |
> |---|---|---|
> | `build/client/_app/` | SvelteKit adapter-node | `/_app/` |
> | `.next/static/` | Next.js | `/_next/static/` (qua `--static-alias`) |
> | `.output/public/_nuxt/` | Nuxt 3 / Nitro | `/_nuxt/` |
> | `.output/public/_build/` | SolidStart / Vinxi | `/_build/` |
> | `dist/client/_astro/` · `dist/_astro/` | Astro | `/_astro/` |
> | `build/client/assets/` | Remix / React Router v7 | `/assets/` — **chỉ gợi ý** |
> | `dist/assets/` | Vite (SPA) | `/assets/` — **chỉ gợi ý** |

> **Next.js: KHÔNG bao giờ lấy `/_next/` làm tiền tố, chỉ `/_next/static/`.**
> Phần còn lại của `/_next/` **phải** đi qua Node: `/_next/image` là bộ tối ưu
> ảnh chạy lúc request, `/_next/data` là payload điều hướng phía client. Chiếm
> cả `/_next/` bằng nginx là mất tối ưu ảnh và hỏng navigation.
>
> Next.js cũng là framework duy nhất trong bảng cần `--static-alias` thay vì
> `--static-root`: file nằm ở `.next/static/…` nhưng URL là `/_next/static/…`.
> `root .next` sẽ đi tìm `.next/_next/static/…` — đường dẫn không tồn tại, nên
> **toàn bộ JS/CSS trả 404 và trang trắng**. `alias` thì thay thế đúng tiền tố.

> **`/assets/` chỉ được GỢI Ý, không bao giờ tự áp.** `/_app/`, `/_next/`,
> `/_nuxt/`, `/_astro/` là namespace riêng của framework — không app nào đặt
> route ở đó. `/assets/` thì là một đoạn URL bình thường mà app hoàn toàn có thể
> dùng làm route thật. Mà `location ^~` **thắng cả route regex lẫn `proxy_pass`**,
> nên áp nhầm là route đó **chết hẳn bằng 404**: không log, không lỗi, chỉ là
> trang trắng. Kiểm tra app trước rồi áp tay bằng `napp app set`.

> **napp tự cấp quyền đọc cho nginx — nếu không thì asset trả 403, không phải
> file.** Thư mục app thuộc **user riêng của app** và để `750`, còn worker nginx
> chạy bằng user khác (`www-data`), nên nó **không đi xuyên qua được**
> `/var/www/<domain>`. Log nginx ghi `Permission denied`, rất dễ đọc nhầm thành
> "sai đường dẫn". `--auto-static`, `--static-root` và `napp check --fix` đều tự
> thêm `www-data` vào **nhóm** của app rồi **restart** nginx (reload *không* đủ:
> danh sách nhóm chỉ được đọc lúc tiến trình khởi tạo). Đánh đổi: nginx đọc được
> cây mã nguồn của app ở mức nhóm — `.env` vẫn an toàn vì để `600`, và nginx chỉ
> phục vụ đúng các tiền tố `^~` đã khai báo.

### File người dùng tải lên — `--upload-dir` (khác asset build)

Từ **1.23.0** `--auto-static` nhận diện luôn thư mục này, nhưng **chỉ trong ca
an toàn**: thư mục tên `uploads`/`upload` nằm **ngay trong gốc tĩnh công khai**
của framework (`static/` với SvelteKit, `public/` với Next/Nuxt/Astro/Vite).
Những thư mục đó theo **định nghĩa của framework** đã công khai — build sao chép
nguyên chúng vào output — nên phục vụ chúng **không mở thêm gì**.

napp **cố ý không đoán** thư mục nằm ngoài gốc tĩnh (`./uploads`, `./storage`,
`./media`…): chỗ đó app tự chọn, không có gì bảo đảm được phép công khai, và
đoán sai ở đây là **đem file riêng tư ra đường**. Khai báo tay bằng
`--upload-dir` cho những trường hợp đó.

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

### Chặn hotlink — hai lớp, sức mạnh rất khác nhau

```bash
sudo napp app set pghotel.vn --hotlink-protect
```

Từ **1.23.0** cờ này bật **hai** lớp, và cần hiểu rõ lớp nào làm được gì:

| | `Cross-Origin-Resource-Policy` | `valid_referers` |
|---|---|---|
| Ai thực thi | **Trình duyệt người xem**, theo header server bạn gửi | nginx của bạn, theo header trang nhúng khai |
| Trang hotlink lách được? | **Không** — nó không đổi được header bạn gửi | **Được**, chỉ cần một thẻ `<meta name="referrer" content="no-referrer">` |
| Còn tác dụng sau CDN? | **Có** — nằm trong chính response đã cache | **Gần như không** — CDN cache theo URL, trả cho mọi referer |
| Cho phép domain ngoài? | Không (chỉ same-origin/same-site/cross-origin) | **Có** — `--hotlink-allow partner.com` |
| Chặn được scraper server-side? | Không | Không |

Nói ngắn: **CORP là lớp thật sự chặn được**, `valid_referers` là rào cản tuỳ
tiện còn lại để hỗ trợ danh sách cho phép. Trước 1.23.0 napp chỉ có lớp thứ hai —
tức là hotlink chặn được bằng **một dòng HTML** ở phía trang đi ăn cắp.

napp dùng `same-site` chứ không `same-origin`: napp tự thêm alias `www.<domain>`
và admin/api thường nằm ở subdomain khác, nên `same-origin` sẽ chặn **chính site
của bạn** nhúng ảnh của mình.

> **CORP không được phát khi bạn dùng `--hotlink-allow`.** CORP chỉ có ba giá trị
> và **không diễn đạt được danh sách cho phép theo domain** — bật nó lên là chặn
> đúng những đối tác bạn vừa cho phép, và ảnh vỡ ở phía họ mà không ai báo cho
> bạn. Khi đó chỉ còn `valid_referers`, tức là chỉ còn rào cản tuỳ tiện; napp nói
> rõ điều này ra mỗi lần bạn cấu hình. Cần chặn **thật** mà vẫn cho đối tác nhúng
> thì phải dùng **URL ký** (`ngx_http_secure_link_module`) hoặc bật ở tầng CDN.

**Muốn chặt hơn nữa** — bỏ luôn nhóm không có `Referer`:

```bash
sudo napp app set pghotel.vn --hotlink-protect --hotlink-strict
```

> ⚠️ `--hotlink-strict` **đắt hơn nhiều so với thứ nó ngăn được**: bot lấy ảnh
> preview (Facebook, Zalo, Telegram, Slack) thường **không gửi `Referer`**, nên
> mọi link chia sẻ của bạn **mất ảnh preview**. Người dùng thật sau proxy công ty
> (nhóm `blocked`) cũng bị **403**. Với CORP đã bật sẵn, phần lớn trường hợp
> **không cần** cờ này — CORP đã chặn nhúng cross-site rồi, mà **không** đụng tới
> bot preview (chúng tải ảnh ở phía server, CORP là cơ chế của trình duyệt) và
> không đụng tới việc gõ thẳng URL ảnh (đó là điều hướng, không phải nhúng).

> **Nếu bạn đang dùng Cloudflare proxy**, hãy bật thêm **Hotlink Protection**
> trong Scrape Shield. Kiểm tra `Referer` ở origin gần như vô nghĩa sau CDN: ảnh
> đã vào cache edge được Cloudflare trả cho mọi referer mà **không hỏi origin**,
> nên cấu hình origin chỉ tác dụng ở lần cache MISS. (CORP thì vẫn chạy, vì nó đi
> theo response.) Đừng "chữa" bằng `Vary: Referer` — nó biến mỗi referer thành
> một bản cache riêng và phá nát hiệu quả cache.

> **Không lớp nào chống được scraper server-side.** Một script `curl` về rồi tự
> host lại thì mọi cơ chế trên đều vô hiệu — chúng chỉ chặn **nhúng trực tiếp**.
> Ảnh thật sự riêng tư phải đi qua kiểm soát truy cập của app (URL ký có hạn
> dùng, kiểm tra phiên đăng nhập), không phải qua cấu hình nginx.

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

---

## 🧩 Location nginx tự viết — dùng file `.custom.conf`

`/etc/nginx/napp-locations/<domain>.conf` là file **tự sinh**: `napp app create`,
`napp app set` và `napp domain add/remove` đều **render lại toàn bộ** nó từ
registry. Mọi thứ bạn thêm tay vào đó sẽ biến mất vào lần chạy kế tiếp của bất kỳ
lệnh nào trong ba lệnh trên — và triệu chứng (ảnh vỡ, route 404) chỉ hiện ra rất
lâu sau, vào lúc **không liên quan gì tới lệnh đã gây ra nó**.

Chỗ đúng để đặt location riêng là file sidecar bên cạnh, napp **không bao giờ**
ghi đè:

```
/etc/nginx/napp-locations/<domain>.conf          <- TỰ SINH, đừng sửa
/etc/nginx/napp-locations/<domain>.custom.conf   <- của BẠN, napp không đụng
```

File `.custom.conf` được `include` **bên trong khối `server`** của vhost, nên
viết thẳng các khối `location …` là được:

```nginx
location ^~ /tai-lieu/ {
    alias /var/www/pghotel.vn/documents/;
    add_header X-Content-Type-Options "nosniff" always;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

> **napp cảnh báo trước khi làm mất.** Trước mỗi lần ghi đè, napp so tập tiền tố
> `location ^~` cũ với mới. Tiền tố nào sắp biến mất thì file cũ được **sao lưu**
> sang `<domain>.conf.napp-orphaned` và napp nói rõ mất cái gì — kèm hai hướng
> xử lý: chuyển sang `.custom.conf` (nếu là location bạn viết), hoặc khai báo lại
> vào registry bằng `napp app set` (nếu đó là cấu hình napp bị rơi mất).
>
> Cố ý so **tiền tố** chứ không dùng fingerprint như unit systemd: file của app
> tạo bằng bản napp cũ không có fingerprint nào, dùng cách đó là **cảnh báo sai
> hàng loạt** ngay lần nâng cấp đầu tiên — và người dùng học được cách bỏ qua
> cảnh báo của napp.

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

## ✍️ Sửa tay unit systemd

Unit napp sinh ra là **file bình thường, sửa tay được**. Việc hay gặp: đổi
`ExecStart` (thêm cờ runtime, đổi entrypoint), đẩy log sang journal thay vì file
(`StandardOutput`/`StandardError`), hoặc chạy bằng `User`/`Group` khác.

napp nhận ra phần bạn đã sửa và **giữ nguyên** ở những lần ghi sau:

```ini
# Managed by napp — site: api.example.com
# napp-fingerprint: 3f9c…            <- napp so dòng này với nội dung file
# napp-preserve: ExecStart StandardOutput
#   ^ directive do BẠN làm chủ — napp sẽ không ghi đè
```

- **fingerprint** là băm của phần còn lại trong file. Khớp = file còn nguyên bản
  napp; lệch (hoặc không có, với unit tạo từ bản napp cũ) = đã có người sửa.
- Khi phát hiện file đã sửa, napp so từng directive; cái nào bạn đổi thì lấy bản
  của bạn và ghi tên vào dòng `# napp-preserve:` để **lần ghi sau vẫn nhớ**.
- Bạn có thể **tự thêm** dòng `# napp-preserve: Tên1 Tên2` để khoá trước một
  directive, kể cả khi chưa sửa gì.

Directive được giữ: `ExecStart*`, `ExecStop*`, `ExecReload`, `Standard*`,
`SyslogIdentifier`, `User`, `Group`, `UMask`, `WorkingDirectory`, `Restart*`,
`Timeout*Sec`, `LimitNOFILE`, `Nice`, `OOMScoreAdjust`, `MemoryMax`,
`MemoryHigh`, `CPUQuota`.

Hai ngoại lệ có chủ đích — napp **vẫn** làm chủ:

- **Phần hardening** (`ProtectSystem`, `NoNewPrivileges`, `ReadWritePaths`…)
  không nằm trong danh sách trên, để bản vá bảo mật còn đường lan tới unit cũ.
- **Directive chính bạn vừa ra lệnh đổi.** Ví dụ `napp service set --run-as`
  đổi `User`/`Group`: giữ bản sửa tay ở đây là làm ngược lại thứ bạn vừa gõ,
  nên napp ghi đè và **báo rõ** directive nào vừa bị đặt lại.

Sau khi sửa tay: `sudo systemctl daemon-reload && sudo systemctl restart <unit>`.

---

## 🔐 Bảo mật mặc định

- Mỗi app: user Linux riêng (`nologin`), thư mục `750`, file `640`, `.env` `600`
- Khi bật asset tĩnh, `www-data` được thêm vào **nhóm của app** để nginx đọc được thư mục build — nginx khi đó đọc được cây mã nguồn ở mức nhóm, nhưng **`.env` vẫn ngoài tầm** (`600`, chỉ chủ sở hữu) và nginx chỉ phục vụ đúng các tiền tố `^~` đã khai báo (không có `try_files` chung)
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
sudo napp tune show     # xem phần cứng phát hiện được + kế hoạch (chưa áp dụng)
sudo napp tune apply    # áp: nginx worker/gzip, MariaDB innodb_buffer_pool, Redis maxmemory, sysctl,
                        # và cân đối heap V8 cho từng app node
sudo napp tune apply --sync-units   # + render lại toàn bộ unit systemd từ template
```

Chạy `napp tune apply` **bất cứ khi nào nâng cấp phần cứng server** (thêm
RAM/CPU) để tự động tính lại và áp cấu hình phù hợp — không cần tính tay.

> **Cân đối heap CHỈ sửa đúng một dòng.** `napp tune apply` (và mọi lần
> tạo/xoá app làm heap phải chia lại) chỉ thay con số trong
> `--max-old-space-size` của dòng `Environment=NODE_OPTIONS` — không render lại
> unit, không đụng `ExecStart` / `StandardOutput` / `StandardError` / `User` /
> `Group` hay dòng nào khác. Chỉ những unit thực sự đổi số mới bị restart.
> Muốn đẩy cả phần template mới (hardening, `ReadWritePaths`) xuống unit tạo từ
> bản napp cũ thì thêm `--sync-units` — bản sửa tay của bạn vẫn được giữ, xem
> mục dưới.

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

## 🧯 Route SvelteKit lồng sâu trả 502 — bộ đệm proxy

Triệu chứng rất dễ nhận: trang chủ và các route nông chạy tốt, nhưng route lồng
sâu kiểu `/admin/hotels/1/rooms/2/edit` trả **502**, trong khi `curl` thẳng vào
`127.0.0.1:<port>` của app lại **đúng**. Log nginx ghi:

```
upstream sent too big header while reading response header from upstream
```

`proxy_buffer_size` là bộ đệm chứa **toàn bộ khối header** của response. Vượt
quá là nginx cắt kết nối và trả 502 — app phía sau hoàn toàn khoẻ mạnh, nên rất
dễ đổ lỗi nhầm cho Node. SvelteKit đụng trần này ở route sâu vì mỗi tầng
layout/page góp thêm mục `Link: </_app/immutable/…>; rel=modulepreload` vào
header, tên file lại có hash dài; cộng thêm `Set-Cookie` phiên đăng nhập là
chạm trần dễ như không.

Từ **1.20.0** bộ đệm được đặt **một chỗ duy nhất** ở mức `http` trong
`/etc/nginx/conf.d/00-napp-proxy.conf`:

```nginx
proxy_buffering on;
proxy_buffer_size 128k;
proxy_buffers 4 256k;
proxy_busy_buffers_size 256k;
```

Site **đã tạo bằng bản cũ** vẫn mang `proxy_buffer_size 16k` ngay trong
`location /` của vhost, mà giá trị trong `location` **luôn thắng** giá trị mức
`http` — nên phải chạy:

```bash
sudo napp nginx sync
```

Lệnh này gỡ khối bộ đệm nội tuyến khỏi vhost (cắt theo dòng, **không** render
lại vhost nên khối SSL certbot chèn vẫn nguyên vẹn), có sao lưu + hoàn tác nếu
`nginx -t` trượt.

> Bộ đệm chỉ được cấp khi có request đang chạy, không phải cấp phát trước — chi
> phí bộ nhớ đi theo tải thực tế, không theo số vhost. Cần giá trị riêng cho một
> site thì thêm `proxy_buffer_size`/`proxy_buffers` vào `location /` của vhost
> đó; giá trị trong `location` luôn thắng.

---

## 🧯 Asset tĩnh trả 403 — quyền đọc của nginx

Triệu chứng: cấu hình `--static-root`/`--upload-dir` **đúng đường dẫn**, file có
thật trên đĩa (`ls` thấy), nhưng trình duyệt nhận **403** cho mọi `.js`/`.css`/
ảnh. Log nginx ghi:

```
open() "/var/www/demo.example.com/build/client/_app/…" failed (13: Permission denied)
```

Chữ **`Permission denied`** rất dễ đọc lướt thành "sai đường dẫn" — nhưng
`failed (13)` là quyền, `failed (2)` mới là không tìm thấy file.

Nguyên nhân nằm ở chính cơ chế cô lập của napp: thư mục app thuộc **user riêng
của app** (`na_<slug>`) với thư mục `750` và file `640`, còn worker nginx chạy
bằng **user khác** (`www-data`). Không thuộc nhóm `na_<slug>` thì `www-data`
thậm chí **không đi xuyên qua nổi** `/var/www/<domain>`, chứ chưa nói tới đọc
file bên trong.

Từ **1.22.0** napp tự xử lý: `--auto-static`, `--static-root` và `napp check
--fix` đều kiểm tra bằng `sudo -u www-data test -r`, và nếu không đọc được thì
thêm `www-data` vào **nhóm** của app rồi **restart** nginx.

```bash
sudo napp check --fix          # phát hiện + sửa cho mọi app đang chạy
sudo napp app set demo.example.com --auto-static   # hoặc sửa cho một app
```

Tự kiểm tra:

```bash
sudo -u www-data test -r /var/www/demo.example.com/build/client && echo OK
id -nG www-data                # phải có na_<slug> của app
```

> **Phải `restart` chứ không `reload`.** Danh sách nhóm bổ sung chỉ được đọc
> lúc tiến trình khởi tạo: master nginx đang chạy giữ nguyên danh sách cũ và
> sinh worker từ đó, nên `reload` xong vẫn **403 y hệt** — một cái bẫy mất hàng
> giờ để lần ra vì "đã cấp quyền rồi mà".

> **Đánh đổi:** sau bước này nginx đọc được cây mã nguồn của app ở **mức nhóm**.
> Không dùng `chmod o+rX` (mở cho mọi user local, phá đúng thứ napp đang giữ) và
> không dùng `setfacl` (cần gói `acl` + filesystem bật acl). Quyền nhóm thì đã
> sẵn đúng — `750`/`640` nghĩa là nhóm ĐÃ có `r-x`/`r--`, việc duy nhất còn
> thiếu là cho nginx vào nhóm. `.env` vẫn an toàn vì để `600` (chủ sở hữu, không
> phải nhóm), và nginx chỉ phục vụ đúng các tiền tố `^~` đã khai báo.

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
                          # validate, hardware, lock, mysql, envfile, cloudflare, network,
                          # framework (nhận diện bố cục asset), staticaccess (quyền đọc cho nginx)
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

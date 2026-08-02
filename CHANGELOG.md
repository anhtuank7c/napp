# Changelog

Tất cả thay đổi đáng chú ý của `napp` được ghi lại ở đây.

## 1.18.0

- **Sửa: Redis `maxmemory-policy` `volatile-lru` → `noeviction`.** BullMQ kiểm tra ngay lúc kết nối và báo `IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"`. Cảnh báo đó không phải chuyện thẩm mỹ: dữ liệu hàng đợi **không phải cache** — job đang chờ, khoá, kết quả chỉ tồn tại một bản. Với chính sách `*-lru`, khi chạm `maxmemory` Redis **tự trục xuất key** để nhường chỗ, job bốc hơi giữa chừng và **không bên nào báo lỗi** (BullMQ chỉ thấy job "không còn tồn tại").

  `volatile-lru` — thứ napp đặt từ 1.5.0 — không hề an toàn hơn ở đây: BullMQ **có** đặt TTL cho khoá, rate-limit và job đã hoàn tất, nên "chỉ trục xuất key có TTL" vẫn ăn thẳng vào dữ liệu của hàng đợi. `noeviction` khiến Redis **từ chối lệnh ghi** (báo OOM) khi đầy: hỏng lộ liễu, thấy ngay, còn hơn mất việc trong im lặng.

  Lý do cũ (nhiều app chung một Redis, sợ cache app này trục xuất session app kia) nay được giải quyết đúng chỗ: **không trục xuất gì cả**. Chính sách này áp cho **cả instance**, không tách theo DB index được — chỉ cần một app dùng queue là cả server phải `noeviction`.

  Đánh đổi: Redis đầy thì ghi mới lỗi OOM chứ không tự dọn. Hãy **đặt TTL cho key cache** (key hết hạn vẫn bị xoá bình thường — `noeviction` chỉ tắt việc trục xuất key **chưa** hết hạn) và theo dõi `napp redis info` (`used_memory` so với `maxmemory`).

- **`napp check` kiểm tra `maxmemory-policy` đang chạy.** Server đã chạy `napp tune apply` bằng bản cũ vẫn đang để `volatile-lru` — sinh lại template thôi thì không chạm tới chúng. `napp check` nay đọc `CONFIG GET maxmemory-policy` của **instance đang chạy** và báo nếu khác `noeviction`; `napp check --fix` áp ngay bằng `CONFIG SET` **và** ghi vào `/etc/redis/conf.d/napp-tuning.conf` để bền qua restart — **không restart Redis** (restart là mất mọi job còn trong bộ nhớ chưa kịp vào AOF).

## 1.17.0

- **`ADDRESS_HEADER` / `XFF_DEPTH` giờ là TUỲ CHỌN (`--address-header`), không còn mặc định.** Hai biến này đổi thứ mà `getClientAddress()` của adapter-node trả về: từ **địa chỉ socket** của bên gọi sang một giá trị **parse ra từ header**. Tiện cho app chỉ cần "IP khách là gì", nhưng **phá app tự làm lấy việc đó** — cách làm chuẩn là lấy socket peer, đối chiếu danh sách proxy tin cậy, *rồi* mới tin header. Đặt `ADDRESS_HEADER` là đưa cho phép kiểm tra ấy một giá trị do client cung cấp: nó không bao giờ khớp, app spam log `ignoring forwarding headers from untrusted peer …` mỗi request, và rơi về tin bất cứ thứ gì `XFF_DEPTH` chọn.

  IP thường vẫn ra **đúng**, và đó mới là chỗ nguy hiểm: tính đúng đắn khi đó phụ thuộc hoàn toàn vào `XFF_DEPTH` khớp số hop THẬT. Thêm một hop sau này (CDN, load balancer thứ hai) là nó lặng lẽ đọc phải một mục **client giả mạo được**, trong khi phép kiểm tra lẽ ra bắt được đã bị vô hiệu từ trước. Giá trị đó thường là khoá của rate limiter, nên hỏng ở đây nghĩa là **đăng nhập sai không giới hạn**, không phải một dòng log sai.

  Không đặt thì `getClientAddress()` trả `127.0.0.1` — sai một cách **lộ liễu** và dễ sửa, thay vì sai một cách im lặng. App nào thật sự cần thì bật lại bằng `--address-header`.

  App **đã tạo** không đổi gì (napp không sửa `.env` có sẵn). Muốn gỡ: xoá hai dòng đó khỏi `.env` rồi `napp app restart <domain>`.

- **Sửa chú thích sai về `XFF_DEPTH`.** Bản cũ ghi "có CDN/WAF trước nginx thì tăng lên 2". Sai khi nginx đã bật Cloudflare real-IP (`napp cloudflare sync`): lúc đó `$remote_addr` **đã là** IP khách thật nên `$proxy_add_x_forwarded_for` nối thêm chính nó — vẫn là **1**. Làm theo lời khuyên cũ sẽ đọc lùi một hop và lấy nhầm IP.

## 1.16.0

- **`napp app set <domain>` — đổi cấu hình nginx của app ĐÃ TẠO.** Các tuỳ chọn thêm ở 1.15.0 (`--static-root`, `--upload-dir`, `--hotlink-protect`, `--max-body`) trước đó chỉ áp dụng lúc **tạo app**. `napp nginx sync` không giúp được: nó chỉ vá đúng một chuỗi (`Connection "upgrade"`) chứ không render lại vhost — và cố ý như vậy, vì **certbot chèn khối SSL thẳng vào vhost**, render lại là xoá HTTPS của site đang chạy.

  ```bash
  sudo napp app set pghotel.vn \
    --static-root /var/www/pghotel.vn/apps/backend/build/client --static-prefix /_app/ \
    --upload-dir /var/www/pghotel.vn/apps/backend/static/uploads \
    --hotlink-protect --max-body 100M
  ```

- **Location riêng của app chuyển sang file include.** `/etc/nginx/napp-locations/<domain>.conf` do napp sở hữu trọn vẹn; vhost chỉ mang **đúng một dòng** `include`. Nhờ vậy mọi lần đổi cấu hình về sau chỉ ghi lại một file, **không bao giờ chạm vào vhost** nên không có gì của certbot để làm hỏng. Dòng `include` được chèn vào **khối server đang proxy tới upstream của app** (dò bằng đếm ngoặc, không phải regex), một lần duy nhất và idempotent — đã kiểm chứng trên vhost certbot đã sửa: 8/8 dòng `managed by Certbot` giữ nguyên, `ssl_certificate` còn nguyên, khối redirect `:80` không bị chèn. Có sao lưu + hoàn tác nếu `nginx -t` trượt.

- **Sửa: `napp domain add/remove` âm thầm làm mất HTTPS.** `regenerateNginxConf` ghi đè **toàn bộ** vhost, nên khối SSL certbot chèn vào đó biến mất và site tụt về HTTP — không thông báo gì, chỉ lộ ra khi có người truy cập bằng `https://`. Nay có **cảnh báo rõ ràng kèm lệnh cấp lại** (`napp cert issue …`), và thêm sao lưu + hoàn tác khi `nginx -t` trượt. (Render lại vẫn là hành vi hiện có; cảnh báo là phần còn thiếu.)

- **Sửa: app tạo bằng bản cũ có thể làm sập nginx TOÀN MÁY.** Vhost nay `include` file location, mà nginx **từ chối khởi động** nếu include trỏ vào file không tồn tại. `app create` và `napp domain` đều ghi file này trước khi ghi vhost, kể cả khi app không bật tuỳ chọn nào (khi đó file chỉ chứa chú thích). `app remove` và rollback lúc tạo lỗi đều dọn file.

- **`NginxAppOptions` không còn bản sao của `staticRoot`/`uploadDir`/`hotlink*`** — chúng chỉ nằm trên `AppRecord`. Để lại bản sao ở cả hai nơi là dựng lại đúng cái bẫy vừa sửa cho `clientMaxBodySize`: một tham số trông như có tác dụng nhưng không chỗ gọi nào đọc.

## 1.15.0

- **Cặp web + worker dùng CHUNG Redis DB được rồi — `--share-redis-with` / `--redis-db`.** Trước đây `--redis` luôn cấp index rảnh kế tiếp, nên tạo web app rồi tạo worker sẽ ra **hai DB khác nhau**. Hàng đợi (BullMQ, Sidekiq, Celery...) chỉ chạy khi bên đẩy việc và bên tiêu thụ nhìn cùng một keyspace: khác DB thì web đẩy job vào `#1`, worker ngồi nghe `#2`, **không bên nào báo lỗi** — job chất đống còn mọi tác dụng phụ (email, thông báo, resize ảnh) im lặng không bao giờ chạy. Nay:

  ```bash
  sudo napp app create shop.example.com --repo ... --redis
  sudo napp service create shop-worker  --repo ... --share-redis-with shop.example.com
  ```

  Tạo service với `--redis` mà **không** chỉ định dùng chung thì napp in cảnh báo tại chỗ, vì đây là cái sai không có triệu chứng. Khi nhiều đơn vị dùng chung một index, xoá một đơn vị **không** trả index về danh sách trống nữa (trước đây trả, khiến DB đang dùng bị cấp lại cho sản phẩm khác và hai bên ghi đè key của nhau).

- **`--static-root` + `--static-prefix`: để NGINX trả asset thay vì Node.** Vhost trước đây không có `root` nào, nên **mọi** file — từng chunk `.js`, `.css`, `.woff2` — đều đi qua tiến trình Node. Một trang của app SSR/SPA hiện đại kéo hàng trăm chunk, tất cả xếp hàng trên event loop đơn luồng và tranh chấp với chính việc render trang. Đây là nguyên nhân phổ biến nhất của "vào dashboard thấy giựt" dù đo server vẫn nhanh.

  ```bash
  sudo napp app create app.example.com --repo ... \
    --static-root /var/www/app.example.com/build/client \
    --static-prefix /_app/
  ```

  CỐ Ý chỉ phục vụ theo **tiền tố khai báo**, không dùng `try_files $uri` chung cho `location /`: một try_files chung sẽ đem cả cây thư mục ra đường và có thể trả `index.html` tĩnh thay vì để app tự render. Tiền tố có tên băm nội dung thì không bao giờ đụng route của app — SvelteKit `/_app/`, Next.js `/_next/static/`, Vite `/assets/`. Ba header bảo mật được lặp lại trong location tĩnh vì chỉ cần một `add_header` ở location con là nginx **bỏ toàn bộ** `add_header` kế thừa từ khối server — không lặp thì riêng file tĩnh mất `nosniff`.

- **`--upload-dir`: file người dùng tải lên KHÔNG phải asset build.** Đây là cái bẫy riêng, `--static-root` không giải quyết được. Với SvelteKit adapter-node (và tương tự), thư mục `static/` được **sao chép vào `build/client/` lúc build**, còn lúc chạy server chỉ phục vụ `build/client`. Nên một ảnh admin tải lên **sau** khi build — nằm ở `static/uploads` — không có trong `build/client` và server trả **404 dù file có thật trên đĩa**. Đo trên một bản build thật: file có sẵn lúc build → `200`; file tải lên sau đó → `404`.

  Triệu chứng rất dễ đọc nhầm: ảnh vừa tải lên bị vỡ, rồi **tự nhiên hiện ra sau lần deploy kế tiếp** (vì build lại sao chép `static/`), nên nó giống lỗi chập chờn hoặc lỗi cache hơn là lỗi cấu hình.

  ```bash
  sudo napp app create pghotel.vn --repo ... \
    --upload-dir /var/www/pghotel.vn/apps/backend/static/uploads
  ```

  Mặc định tiền tố URL là `/uploads/`, đổi bằng `--upload-prefix`. `Cache-Control` ở đây cố ý **ngắn** (1 ngày) và **không** `immutable`: tên file tải lên không băm nội dung nên cùng một URL có thể đổi nội dung, `immutable` sẽ khoá bản cũ trong cache trình duyệt hàng năm trời.

- **`--hotlink-protect`: chỉ cho nhúng ảnh từ domain của mình.** Áp lên `--upload-dir`, dùng `valid_referers … server_names` nên thêm domain phụ vào site là tự động được phép, không phải sửa hai nơi. Thêm domain ngoài bằng `--hotlink-allow` (lặp lại được).

  ```bash
  sudo napp app create pghotel.vn --repo ... \
    --upload-dir /var/www/pghotel.vn/apps/backend/static/uploads \
    --hotlink-protect --hotlink-allow partner.example.com
  ```

  **`none` và `blocked` được phép có chủ đích** — đây là phần dễ làm sai nhất. `none` là request không có `Referer`: gõ thẳng URL ảnh, trình duyệt cắt `Referer` vì quyền riêng tư, và quan trọng nhất là **bot lấy ảnh xem trước khi chia sẻ link** (Facebook, Zalo, Telegram, Slack) — chúng thường không gửi `Referer`. Chặn `none` nghĩa là mọi link chia sẻ mất ảnh preview, thiệt hại lớn hơn nhiều so với hotlink ngăn được. `blocked` là `Referer` bị proxy doanh nghiệp xoá — chặn nhóm này là chặn nhầm người dùng thật.

  **Hai giới hạn phải biết trước khi tin vào nó.** (1) `Referer` do trình duyệt tự khai: trang hotlink chỉ cần đặt `<meta name="referrer" content="no-referrer">` là rơi vào nhóm `none` và đi qua — đây là biện pháp chặn hotlink **tuỳ tiện**, không phải kiểm soát truy cập, đừng dùng để bảo vệ ảnh riêng tư. (2) Nếu có CDN đứng trước (Cloudflare…), CDN cache theo URL và **không quan tâm `Referer`**: ảnh đã vào cache edge sẽ được trả cho mọi referer mà không hỏi origin, nên cấu hình này chỉ tác dụng với lần cache MISS — muốn chặn thật thì bật ở tầng CDN. Đừng "chữa" bằng `Vary: Referer`: nó biến mỗi referer thành một bản cache riêng và phá nát hiệu quả cache.

  Đã kiểm chứng bằng nginx thật: không `Referer` / `pghotel.vn` / `www.pghotel.vn` / domain trong `--hotlink-allow` → `200`; domain lạ → `403`; và `pghotel.vn.evil.com` → `403` (cái bẫy mà rule viết bằng regex hay lọt).

- **`--max-body` thực sự có tác dụng.** `client_max_body_size` vẫn luôn là `20M` dù `NginxAppOptions` đã có sẵn tham số — **không chỗ gọi nào truyền nó**. Upload lớn hơn thế bị nginx chặn bằng `413` trước khi tới app. Nay giá trị nằm trong bản ghi app và template đọc thẳng từ đó, nên thêm chỗ gọi mới cũng không thể quên.

- **`--app-dir`: chạy được app trong MONOREPO.** `WorkingDirectory` và `EnvironmentFile` luôn trỏ vào gốc mã nguồn, đúng với repo một-package nhưng sai với monorepo. Hệ quả với pnpm: Node phân giải import trần bằng cách đi ngược lên từ file gọi, mà pnpm chỉ symlink gói vào `node_modules` của *package đó* — chạy từ gốc repo thì một gói có thật vẫn báo `ERR_MODULE_NOT_FOUND`. Và vì `EnvironmentFile` có tiền tố `-` (bỏ qua nếu thiếu), `.env` ghi sai chỗ khiến app khởi động **rỗng biến môi trường mà không có lỗi nào được in ra**.

  ```bash
  sudo napp app create pghotel.vn --repo ... \
    --app-dir apps/backend --build-cmd "cd apps/backend && pnpm build"
  ```

  `ReadWritePaths` vẫn là **gốc mã nguồn** chứ không phải thư mục con: `ProtectSystem=strict` biến mọi đường dẫn ngoài danh sách thành chỉ-đọc, mà thư mục ứng dụng ghi ra ngoài phạm vi của mình là chuyện bình thường (uploads, cache dùng chung), và lỗi khi đó là `EROFS` lúc chạy chứ không phải lúc khởi động.

- **`gzip_proxied any` trong `napp-tuning.conf`.** Chỉ thị này quyết định có nén hay không khi **request của client mang header `Via`** — nginx đọc `Via` là "request này đã đi qua một proxy". Đây *không* phải "phản hồi đến từ upstream": không có `Via` thì nginx nén bình thường bất kể có `proxy_pass` hay không. Đo trên một trang 132 KB với `Accept-Encoding: gzip`: không `Via` thì cả hai cấu hình đều nén; **có `Via` thì thiếu dòng này trả nguyên 132 KB**. Cloudflare không gửi `Via` nên site sau Cloudflare thường không dính, nhưng Fastly, Varnish, squid và phần lớn proxy doanh nghiệp thì có — và khi dính thì triệu chứng là "chậm với một số người dùng", gần như không lần ra được.

- **Bộ đệm proxy đủ cho một trang SSR**: `proxy_buffer_size` 8k → 16k và `proxy_buffers` 8×8k → 16×16k. 64 KB đủ cho API trả JSON nhỏ, nhưng phần vượt quá bộ đệm bị nginx **ghi ra file tạm trên đĩa rồi đọc lại**, mỗi request một lần — một trang admin 300 KB nghĩa là ~240 KB ghi/đọc đĩa cho mỗi lượt xem.

- App/service **đã tạo** không đổi hành vi (napp đọc mọi đường dẫn từ registry). Muốn áp phần nginx cho app đang chạy: `napp nginx sync`.

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

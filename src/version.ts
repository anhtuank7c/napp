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

## 1.27.0
- MỚI: TỰ CHỌN DATABASE ENGINE — MariaDB (mặc định), MySQL, PostgreSQL, MongoDB;
  cài một, vài, hoặc KHÔNG cài gì. Chưa từng chọn = MariaDB như trước, nên nâng
  cấp napp không đổi gì trên server đang chạy.
- Chọn lúc cài: 'curl ... | sudo NAPP_DB=postgresql bash', hoặc
  'napp check --fix --db postgresql' ('none' = không dùng DB). Lần đầu check --fix
  trên máy chưa có engine nào sẽ HỎI.
- 'napp db engine list|add|remove|default|select'. '--db [engine]' cho app/service
  create, '--engine' cho db create|drop|list|backup và backup run. Máy có nhiều
  engine mà không chỉ định -> napp dừng lại bắt chọn, KHÔNG đoán.
- .env có thêm DATABASE_URL (Prisma/Drizzle/TypeORM/Knex/Mongoose đọc thẳng).
- MariaDB + MySQL bị chặn cài chung (xung đột apt, cùng cổng 3306, cùng datadir).
- SỬA LỖI NGẦM: RAM cho DB bị giữ chỗ kể cả khi máy KHÔNG có DB -> heap V8 bị bóp
  vô cớ. Nay 0 engine = 0%, nhiều engine CHIA NHAU cùng một phần (không cộng dồn).
  Chạy 'sudo napp tune apply' để áp.
- Gỡ engine an toàn: từ chối khi còn app dùng; DB lẻ cần --force và được dump
  toàn bộ trước; mặc định GIỮ dữ liệu, chỉ --purge mới xoá (phải gõ tên engine).
  Engine đã gỡ không bị check --fix cài lại.
- MongoDB: kiểm tra AVX trước khi cài, BẬT xác thực ngay (mặc định của MongoDB là
  tắt), đặt cache WiredTiger theo ngân sách RAM. Mật khẩu không nằm trong argv.
- Trước khi cài engine: cổng mặc định đã bị chiếm (vd container Docker publish
  5432) -> dừng và nêu tên tiến trình; thiếu đĩa -> dừng trước khi apt chạy.
- Mọi lệnh apt chờ khoá dpkg (tối đa 5 phút) thay vì chết ngay khi
  unattended-upgrades đang chạy — chuyện gần như chắc chắn gặp trên VPS mới.
- check/doctor cảnh báo database lắng nghe ngoài 127.0.0.1 (kể cả cổng 33060
  của MySQL), chỉ rõ dòng cấu hình cần sửa.
- Backup tách thư mục theo engine (/var/backups/napp/db/<engine>/). SỬA LỖI: dump
  dùng pipefail — trước đây mysqldump lỗi vẫn để lại file .sql.gz rỗng.

## 1.26.0
- MỚI 'napp mem': phát hiện rò rỉ bộ nhớ TRƯỚC khi app chết, và chụp heap để tìm
  thủ phạm. Không sửa một dòng code nào của app.
- TÍN HIỆU ĐÃ NẰM SẴN Ở ĐÓ TỪ ĐẦU: mọi unit napp đều có 'Restart=always', nên app
  rò rỉ chạm trần heap sẽ CHẾT rồi được systemd LẶNG LẼ khởi động lại — lặp đi
  lặp lại nhiều ngày mà không ai hay. systemd đã đếm sẵn số lần đó ('NRestarts'),
  chỉ là chưa ai đọc ra. 'napp mem status' và 'napp check' nay đọc ra.
- 'napp mem watch': systemd timer lấy mẫu bộ nhớ định kỳ (mặc định 15 phút) ->
  'napp mem trend' kết luận xu hướng.
- ĐO 'anon' TRONG memory.stat, KHÔNG đo memory.current: memory.current gồm cả
  page cache — thứ phình ra co lại theo I/O của cả máy và đủ nhiễu để dìm chết
  tín hiệu thật. 'anon' là heap/stack, đúng thứ rò rỉ làm phình.
- BA QUY TẮC ĐỂ KHÔNG KÊU OAN (kêu oan vài lần là người dùng học cách phớt lờ):
  (1) chỉ xét đoạn từ lần restart gần nhất — mỗi lần khởi động lại là bộ nhớ về
  mo, ghép hai bên của một lần restart cho ra dốc âm vô nghĩa che mất chính cái
  rò rỉ đã gây ra nó; (2) so TRUNG VỊ hai phần tư đầu/cuối chứ không so mẫu đầu
  với mẫu cuối, vì một mẫu rơi đúng lúc GC lệch hàng chục MB; (3) dưới 6 giờ dữ
  liệu thì KHÔNG kết luận gì — RSS của Node luôn tăng lúc đầu rồi đi ngang vì V8
  không trả bộ nhớ về OS sớm.
- 'napp mem guard <app>': thêm '--heapsnapshot-near-heap-limit=1' và
  '--heapsnapshot-signal=SIGUSR2' vào NODE_OPTIONS. Cờ đầu khiến Node TỰ CHỤP
  heap ngay trước khi chạm trần, thay vì chết mà không để lại gì.
- 'napp mem snapshot <app>': chụp heap của tiến trình ĐANG CHẠY, app vẫn sống.
  Chờ tới khi file NGỪNG TĂNG kích thước rồi mới báo xong — không có bước đó thì
  rất dễ đem đi phân tích một file mới ghi được một nửa.
- AN TOÀN: SIGUSR2 GIẾT tiến trình Node nếu cờ chưa có hiệu lực (đó là hành vi
  mặc định của tín hiệu). Nên napp đọc /proc/<pid>/environ để xác nhận cờ THẬT SỰ
  đang chạy rồi mới dám gửi, và TỪ CHỐI nếu không chắc. Đọc môi trường thật chứ
  không đọc file unit, vì '.env' của app ghi đè được NODE_OPTIONS.
- SỬA LỖI NẶNG: 'Environment=NODE_OPTIONS=...' KHÔNG được bọc nháy kép. systemd
  tách directive này theo DẤU CÁCH, nên nhiều cờ sẽ bị hiểu thành nhiều phép gán
  và MỌI CỜ SAU CỜ ĐẦU TIÊN bị vứt đi — bằng chứng duy nhất là một dòng 'Invalid
  environment assignment, ignoring' trong journal mà không ai đọc. Trước bản này
  chỉ có đúng một cờ nên lỗi chưa lộ; thêm cờ thứ hai là lộ ngay. Đã kiểm chứng
  trên systemd thật: trước khi sửa tiến trình chỉ nhận '--max-old-space-size',
  sau khi sửa nhận đủ cả ba cờ.
- SỐ ĐO THẬT về chi phí chụp heap (đừng chụp app web vào giờ cao điểm): file lớn
  khoảng GẤP ĐÔI heap và mất VÀI PHÚT để ghi — heap 96MB -> file 184MB, 176 giây;
  heap 128MB -> 237MB. Node LUÔN ghi vào thư mục làm việc của app, không đổi được
  chỗ. Dừng/restart đơn vị giữa chừng cho ra file CỤT (đã kiểm chứng: 0 byte).
- 'napp check' báo thêm ba thứ: đơn vị bị systemd khởi động lại, đơn vị có bộ nhớ
  tăng liên tục, và file .heapsnapshot còn sót trong thư mục app (bằng chứng app
  đã chạm trần heap).
- CỐ Ý KHÔNG biến napp thành APM: cần quan sát thật sự thì prom-client +
  Prometheus/Grafana mới đúng công cụ. Và tuyệt đối không dùng '--inspect' trên
  production — nó mở cổng debugger, ra tới Internet là tương đương RCE.

## 1.25.0
- MỚI: WEB APP ĐƯỢC ƯU TIÊN HƠN BACKGROUND SERVICE. Trước đây napp đối xử với hai
  loại này hoàn toàn như nhau — cùng phần heap, và KHÔNG có ưu tiên CPU nào cả.
  Nghĩa là một worker cron chạy mỗi giờ được đúng bằng heap của web app đang phục
  vụ traffic, và một worker nén ảnh tranh CPU ngang cơ với nó.
- Heap V8 nay chia theo TRỌNG SỐ: mẫu số là 'số app + số service * 0.5' thay vì
  tổng số đơn vị. Tổng RAM cấp phát KHÔNG đổi, chỉ phân bổ lại về phía traffic.
  Ví dụ máy 4GB, 2 app + 2 service: trước cả bốn được 327MB; nay web 436MB,
  service 218MB (tổng vẫn 1308MB). Đổi tỷ lệ bằng 'tune apply --service-weight'
  (0.1-1; 1 = chia đều như trước).
- HEAP LÀ LỚP YẾU NHẤT, đừng trông chờ vào nó. '--max-old-space-size' là một
  TRẦN chứ không phải RAM đặt trước: cho web app heap lớn hơn KHÔNG lấy đi gì của
  worker, nó chỉ cho web app lớn thêm trước khi thrash GC hoặc chết.
- MỚI 'CPUWeight' (web 200 / service 50) và 'IOWeight' trong unit systemd — ĐÂY
  mới là lớp người dùng thật sự cảm nhận được. Một worker sharp/ffmpeg chiếm hết
  lõi làm mọi request chậm hẳn, và không con số heap nào đổi được điều đó.
  CPUWeight là tỷ lệ chia CHỈ áp dụng KHI CÓ TRANH CHẤP: worker rảnh thì web app
  vẫn dùng 100% CPU như thường. Đo trên máy thật, hai tiến trình cùng đốt CPU
  100% trên một lõi 12 giây: web 9597ms, worker 2401ms — đúng 4.00 : 1.
- MỚI 'MemoryHigh' cho background service (3x heap, sàn 256MB): giới hạn MỀM —
  vượt ngưỡng thì kernel throttle và thu hồi bộ nhớ của riêng worker đó, KHÔNG
  giết tiến trình. CỐ Ý KHÔNG dùng MemoryMax (giới hạn cứng, vượt là OOM-kill):
  biến một worker chậm thành một worker CHẾT thì tệ hơn vấn đề ban đầu. Web app
  KHÔNG bị đặt MemoryHigh.
- ÁP ĐƯỢC CHO UNIT TẠO BẰNG BẢN NAPP CŨ: CPUWeight/IOWeight được vá vào unit hiện
  có bằng một phép PHẪU THUẬT riêng (patchUnitPriority) — không render lại unit,
  không đụng ExecStart/User/Group. Không có bước này thì directive mới chỉ tới
  được unit cũ qua '--sync-units', thứ gần như không ai chạy: lệnh báo thành
  công, 'tune show' in ra tỷ lệ ưu tiên, mà unit thật thì trống không.
  Ưu tiên CPU/IO áp NGAY bằng daemon-reload, KHÔNG cần restart app (đã kiểm
  chứng: cpu.weight trong kernel đổi 200 -> 350 với cùng PID). Chỉ heap mới bắt
  buộc restart vì NODE_OPTIONS chỉ được đọc lúc tiến trình khởi động.
- ĐỪNG TIN 'systemctl show -p CPUWeight': nó chỉ đọc lại giá trị đã CẤU HÌNH
  trong unit, kể cả khi cgroup controller 'cpu' không bật và dòng đó hoàn toàn vô
  hiệu — đo được trường hợp systemctl trả 200 trong khi hai tiến trình vẫn chia
  CPU 1:1. 'tune apply' nay đối chiếu với 'cpu.weight' THẬT trong cgroup và báo
  cáo kết quả thật.
- TRUNG THỰC VỀ THỨ KHÔNG CHẠY: IOWeight chỉ hiệu lực với I/O scheduler 'bfq'
  (VPS NVMe thường dùng 'none'/'mq-deadline' -> kernel không tạo cả file
  io.weight), và MemoryHigh chỉ tồn tại ở cgroup v2 (Ubuntu 22.04+). 'tune show'
  dò và nói thẳng máy bạn thuộc nhóm nào; trên cgroup v1 napp BỎ HẲN dòng
  MemoryHigh thay vì ghi ra một directive kernel sẽ lờ đi.
- '--service-weight' được LƯU vào registry chứ không chỉ là cờ của một lần chạy:
  không nhớ thì lần 'app create' kế tiếp sẽ tính lại theo mặc định và âm thầm lật
  ngược lựa chọn của người dùng.
- SỬA LỖI: 'app create' tính heap chỉ theo SỐ APP WEB, bỏ qua background service —
  nên app đầu tiên trên một máy đã có sẵn worker nhận heap quá lớn (và chỉ được
  sửa lại nếu về sau có app thứ hai). Nay mẫu số luôn tính cả hai loại.
- 'napp check' báo thêm: unit nào còn thiếu CPUWeight/IOWeight. '--fix' áp được
  mà KHÔNG cần restart app.
- CPUWeight/IOWeight nằm trong danh sách '# napp-preserve:' — đặt tay giá trị
  riêng cho một worker cụ thể thì napp không ghi đè.

## 1.24.0
- MỚI: 'napp nginx scanblock' — chặn quét lỗ hổng CMS/framework PHP ở tầng nginx.
  Request dò '/wp-login.php', '/wp-admin/', '/phpmyadmin/', '/cgi-bin/' và mọi
  đuôi .php/.asp/.jsp bị trả 444 ngay, KHÔNG vòng qua Node. Gỡ bằng
  'napp nginx unscanblock'; tắt riêng một site: 'napp app set <domain>
  --no-scan-block'.
- ĐỪNG KỲ VỌNG SAI VÀO CON SỐ: 444 KHÔNG tiết kiệm nhiều CPU như tên gọi gợi ý —
  phần đắt nhất của một request quét là bắt tay TCP + TLS, mà nginx đã trả xong
  khoản đó TRƯỚC khi nhìn thấy URI. Thứ tiết kiệm được là vòng qua Node. Khoản
  lời thật: access log của site sạch trở lại, và fail2ban có tín hiệu ban gần như
  hoàn hảo (ban ở tường lửa mới là chỗ bỏ được cả bắt tay).
- Vì lý do trên, request bị chặn ghi sang FILE LOG RIÊNG
  '/var/log/nginx/napp-scanner.log' chứ KHÔNG dùng 'access_log off'. Tắt log là
  jail 'nginx-botsearch' (đọc /var/log/nginx/*access.log) mất luôn tín hiệu: log
  sạch nhưng scanner không bao giờ bị ban.
- MỚI: jail fail2ban 'napp-scanner' đọc file log riêng đó — mọi dòng trong nó
  chắc chắn là scanner nên ban rất chặt (3 lần / 10 phút -> cấm 1 ngày) mà không
  có rủi ro ban nhầm.
- SỬA LỖI: các jail nginx của fail2ban trước đây KHÔNG đọc được gì. '[DEFAULT]'
  đặt 'backend = systemd' (đúng cho sshd), nhưng backend đó khiến fail2ban BỎ QUA
  'logpath' và đi đọc journal — trong khi nginx ghi access log ra FILE. Jail vẫn
  'enabled', 'fail2ban-client status' vẫn xanh, số IP bị ban đứng yên ở 0 mãi
  mãi, không có lỗi nào để lần. Nay các jail nginx ghi đè 'backend = auto'.
- ÁP ĐƯỢC CHO APP TẠO BẰNG BẢN NAPP CŨ: vhost tạo trước 1.19.0 không có dòng
  'include' file location nào, nên mọi thứ napp ghi vào /etc/nginx/napp-locations/
  đều không tới được chúng — kể cả chặn quét. 'napp nginx sync' và
  'napp nginx scanblock' nay tự chèn dòng include còn thiếu, bằng phép cắt chuỗi
  theo khối server (KHÔNG render lại vhost, nên khối SSL của certbot giữ nguyên).
- 'napp check' báo thêm hai thứ: vhost nào còn thiếu dòng include (asset tĩnh,
  upload, hotlink, chặn quét đều "đã cấu hình" mà không hề chạy — nginx -t vẫn
  xanh), và chặn quét lỗ hổng chưa từng được bật.
- 'napp nginx sync' nay hoàn tác THEO GIAO DỊCH: một lệnh chạm tới bốn loại file
  nhân với số app, và hoàn tác nửa vời ở đây không phải "mất cấu hình" mà là
  nginx KHÔNG NẠP ĐƯỢC (vhost có dòng include còn file được include thì vừa bị
  xoá) — tức là TẮT mọi site trên máy.
- CHÚ Ý: 'napp nginx sync' nay render lại file location '<domain>.conf' từ
  registry (trước đây chỉ vá vhost). Sửa tay file đó sẽ bị ghi đè — có cảnh báo
  và sao lưu '.napp-orphaned'. Chỗ đúng để đặt location riêng vẫn là file
  sidecar '<domain>.custom.conf'.
- Menu tương tác: thêm mục 13 (chặn quét) và 14 (gỡ chặn) ở nhóm Hạ tầng — thêm
  vào CUỐI để không đánh số lại "Xem/Áp tối ưu phần cứng" (11, 12).

## 1.23.0
- SỬA LỖI: file location TỰ SINH ghi đè mất phần người dùng thêm tay, KHÔNG cảnh
  báo. '/etc/nginx/napp-locations/<domain>.conf' được render lại TOÀN BỘ từ
  registry ở BA chỗ ('app create', 'app set', 'domain add/remove'), trong khi nó
  cũng là chỗ DUY NHẤT đặt được location riêng — nên ai thêm tay một location
  (ví dụ '/uploads/') đều mất nó vào lần chạy kế tiếp của bất kỳ lệnh nào trong
  ba lệnh đó. Triệu chứng (ảnh vỡ, 404) hiện ra rất lâu sau, vào lúc không liên
  quan gì tới lệnh đã gây ra.
- MỚI: file sidecar '<domain>.custom.conf' — napp include nó vào cuối file tự
  sinh và KHÔNG BAO GIỜ ghi đè. Đây là chỗ ĐÚNG để đặt location riêng.
- Trước khi ghi đè, napp so tập tiền tố 'location ^~' cũ với mới: tiền tố nào
  sắp biến mất thì SAO LƯU file cũ ('.napp-orphaned') và nói rõ mất cái gì, mất
  đi đâu. Cố ý so tiền tố chứ không dùng fingerprint như unit systemd: file của
  app tạo bằng bản napp cũ không có fingerprint nào, dùng cách đó là cảnh báo sai
  hàng loạt ngay lần nâng cấp đầu tiên.
- MỚI: '--auto-static' nhận diện luôn THƯ MỤC FILE TẢI LÊN. Chỉ nhận ca AN TOÀN:
  thư mục tên 'uploads'/'upload' nằm NGAY TRONG gốc tĩnh công khai của framework
  ('static/' của SvelteKit, 'public/' của Next/Nuxt/Astro/Vite). Những thư mục đó
  theo định nghĩa của framework ĐÃ công khai (build sao chép nguyên chúng vào
  output), nên phục vụ chúng KHÔNG mở thêm gì — nó chỉ vá đúng khoảng trống: file
  tải lên SAU lần build gần nhất không có trong output nên trả 404, rồi tự hiện
  ra sau lần deploy kế tiếp, trông hệt lỗi chập chờn.
  CỐ Ý KHÔNG đoán thư mục NGOÀI gốc tĩnh ('./uploads', './storage', './media'):
  chỗ đó app tự chọn, không gì bảo đảm được phép công khai, và đoán sai là đem
  file riêng tư ra đường. Vẫn khai báo tay được bằng '--upload-dir'.
- Tiền tố URL được đặt kèm theo thư mục nhận diện được: thư mục tên 'upload' (số
  ít) trước đây sẽ bị phục vụ ở '/uploads/' vì đó là mặc định của renderer.
- 'napp check' báo thêm: app nào có thư mục tải lên trong gốc tĩnh công khai mà
  nginx chưa phục vụ. '--fix' sửa được.
- CHẶN HOTLINK MẠNH HƠN HẲN: '--hotlink-protect' nay phát thêm header
  'Cross-Origin-Resource-Policy: same-site' cho MỌI location asset (asset build
  lẫn file tải lên), không chỉ kiểm tra Referer như trước.
  Khác biệt cốt lõi: CORP do TRÌNH DUYỆT NGƯỜI XEM thực thi dựa trên header do
  SERVER BẠN gửi, nên trang hotlink KHÔNG tác động được — trong khi Referer là
  thứ chính trang đó khai báo, chỉ cần <meta name="referrer" content="no-referrer">
  là vô hiệu toàn bộ valid_referers. CORP cũng SỐNG SÓT QUA CDN: Cloudflare cache
  theo URL rồi trả cho mọi referer mà không hỏi origin (làm kiểm tra Referer ở
  origin gần như vô dụng), còn CORP nằm trong chính response đã cache.
  Và nó KHÔNG phá thứ mà chặn Referer gắt phá: bot lấy ảnh preview (Facebook,
  Zalo, Telegram) tải ảnh ở phía SERVER nên không bị áp -> link chia sẻ vẫn có
  ảnh; gõ thẳng URL ảnh là điều hướng cấp cao nhất nên cũng không bị chặn.
  Dùng 'same-site' chứ không 'same-origin' vì napp tự thêm alias 'www.<domain>'
  và admin/api thường ở subdomain khác — 'same-origin' sẽ chặn chính site mình.
- CORP KHÔNG được phát khi có '--hotlink-allow': CORP chỉ có ba giá trị, không
  diễn đạt được danh sách cho phép theo domain, nên phát ra là chặn đúng những
  đối tác vừa cho phép và ảnh vỡ ở phía họ mà không ai báo. napp NÓI RÕ khi rơi
  vào trường hợp này, kèm hướng đi thật (URL ký secure_link, hoặc tầng CDN).
- MỚI '--hotlink-strict': bỏ 'none'/'blocked' khỏi valid_referers. Chặt hơn
  nhưng MẤT ảnh preview khi chia sẻ link và 403 nhầm người dùng sau proxy công
  ty — napp cảnh báo mỗi lần cờ này bật.

## 1.22.0
- MỚI '--auto-static': napp NHẬN DIỆN FRAMEWORK từ THƯ MỤC BUILD rồi cho nginx
  trả thẳng asset, thay vì bắt bạn tự tra tiền tố. Nhận: SvelteKit adapter-node
  ('build/client/_app' -> /_app/), Next.js ('.next/static' -> /_next/static/),
  Nuxt 3/Nitro ('.output/public/_nuxt' -> /_nuxt/), SolidStart/Vinxi
  ('.output/public/_build' -> /_build/), Astro ('dist/client/_astro' hoặc
  'dist/_astro' -> /_astro/). Dùng được ở cả 'app create' và 'app set'.
  Căn cứ là THƯ MỤC CÓ THẬT chứ không phải dependencies: package.json ở gốc
  monorepo không nói được app con dùng adapter nào, và cùng một app SvelteKit
  thì adapter-node sinh 'build/client' còn adapter-static sinh 'build' với deps
  y hệt. Hệ quả: chỉ nhận diện được SAU khi build — chưa build thì báo không
  nhận ra, không đoán bừa.
- MỚI '--static-alias <tiền-tố>=<thư-mục>': phục vụ bằng 'alias' thay vì 'root'.
  Cần cho Next.js — file ở '.next/static/…' nhưng URL là '/_next/static/…', nên
  'root .next' đi tìm '.next/_next/static/…' và TOÀN BỘ JS/CSS trả 404 (trang
  trắng). Với Next.js, napp CHỈ chiếm '/_next/static/': '/_next/image' (tối ưu
  ảnh lúc request) và '/_next/data' (payload điều hướng) PHẢI đi qua Node.
- '/assets/' (Remix · React Router v7 · Vite SPA) CHỈ ĐƯỢC GỢI Ý, không bao giờ
  tự áp — kể cả khi có --auto-static. '/_app/', '/_next/', '/_nuxt/', '/_astro/'
  là namespace riêng của framework nên chiếm được an toàn; '/assets/' thì app
  hoàn toàn có thể dùng làm route thật, mà 'location ^~' thắng cả route regex
  lẫn proxy_pass -> áp nhầm là route đó chết hẳn bằng 404, không log, không lỗi.
- SỬA LỖI: asset tĩnh trả 403 chứ không phải file. Thư mục app thuộc user riêng
  và để 750, worker nginx chạy bằng user khác (www-data) nên không đi xuyên qua
  nổi /var/www/<domain> — nghĩa là MỌI cấu hình --static-root/--upload-dir từ
  trước tới nay đều 403 trên máy sạch, và log nginx ghi 'Permission denied', rất
  dễ đọc nhầm thành sai đường dẫn. napp nay tự thêm www-data vào NHÓM của app
  rồi RESTART nginx (reload không đủ: danh sách nhóm chỉ đọc lúc tiến trình khởi
  tạo). '.env' vẫn an toàn vì để 600.
- 'napp check' nay báo hai thứ mới, cho app ĐANG CHẠY: (1) app nào còn đẩy toàn
  bộ asset qua Node dù nhận diện được framework — loại hỏng không có triệu chứng
  nào ngoài 'vào dashboard thấy giựt'; (2) app nào có cấu hình tĩnh mà nginx
  không đọc được. '--fix' sửa được cả hai (trừ nhóm '/assets/' rủi ro).
- Menu tương tác: thêm mục 'Bật nginx trả asset tĩnh', và bước tạo app có hỏi
  luôn. CỐ Ý hỏi chứ không bật ngầm — napp đang chiếm một tiền tố URL.

## 1.21.0
- Sửa tay unit systemd KHÔNG còn bị ghi đè. Mỗi unit mang dòng
  '# napp-fingerprint:'; lệch fingerprint = đã có người sửa, napp so từng
  directive và giữ lại bản của bạn (ExecStart, StandardOutput/StandardError,
  User, Group, Restart, LimitNOFILE, Nice, MemoryMax...), ghi tên chúng vào
  '# napp-preserve:' để lần ghi sau vẫn nhớ. Bạn cũng tự thêm dòng đó được để
  khoá trước. Phần hardening (ProtectSystem, ReadWritePaths...) CỐ Ý không nằm
  trong danh sách giữ, để bản vá bảo mật còn đường lan tới unit cũ.
- Cân đối heap V8 chỉ sửa ĐÚNG MỘT DÒNG: con số trong --max-old-space-size của
  Environment=NODE_OPTIONS. Không render lại unit, không đụng dòng nào khác.
  Trước đây 'napp tune apply' — và cả việc tạo thêm một app, vì heap chia theo
  tổng số đơn vị node — đều ghi đè cả file, thổi bay cấu hình sửa tay và làm app
  chết ngay lúc restart. Chỉ restart unit thực sự đổi số (app bun không dùng cờ
  heap của V8 nên không còn bị restart vô ích).
- MỚI: 'napp tune apply --sync-units' — render lại toàn bộ unit từ template để
  đẩy hardening/template mới xuống unit tạo từ bản napp cũ. Việc này CŨ VẪN LÀM
  NGẦM, nay phải gõ ra. Directive bạn sửa tay vẫn được giữ.
- Directive chính bạn vừa ra lệnh đổi thì napp vẫn làm chủ: 'napp service set
  --run-as' đặt lại User/Group, unit backup/cloudflare đặt lại ExecStart (nó
  mang chính các tuỳ chọn bạn truyền). napp BÁO RÕ directive nào vừa bị đặt lại.

## 1.20.1
- 'napp --help' có phần VÍ DỤ ở cuối, gồm mục "sau khi cập nhật napp": danh
  sách lệnh tự sinh trả lời được "có lệnh gì" nhưng không nhắc các bước BẮT
  BUỘC sau nâng cấp, mà bỏ qua thì server vẫn mang cấu hình cũ đã hỏng
  (volatile-lru mất job BullMQ, bộ đệm 16k làm route SvelteKit sâu trả 502).
- Menu tương tác có mục "Đồng bộ cấu hình proxy nginx vào vhost đã có" (mục 10
  nhóm Hạ tầng). Trước đó 'napp nginx sync' KHÔNG có trong menu nên người chỉ
  dùng menu không có đường nào chạm tới bước sửa 502. Lưu ý: "Xem đề xuất tối
  ưu phần cứng" xuống 11, "Áp tối ưu phần cứng" xuống 12.
- Mô tả lệnh cập nhật cho khớp thực tế: nginx, nginx sync, check, service create.

## 1.20.0
- SỬA: route SvelteKit LỒNG SÂU trả 502 vì bộ đệm proxy quá nhỏ.
  proxy_buffer_size là bộ đệm chứa TOÀN BỘ KHỐI HEADER của response; vượt quá
  là nginx cắt kết nối, trả 502 và ghi 'upstream sent too big header while
  reading response header from upstream'. App phía sau vẫn khoẻ (curl thẳng
  127.0.0.1:<port> ra đúng) nên rất dễ đổ lỗi nhầm cho Node. SvelteKit đụng
  trần ở route sâu vì mỗi tầng layout/page góp thêm mục 'Link: rel=modulepreload'
  vào header, tên file lại có hash dài; cộng Set-Cookie phiên đăng nhập là chạm
  16k dễ như không. Giá trị mới: proxy_buffer_size 128k, proxy_buffers 4 256k,
  proxy_busy_buffers_size 256k.
- Bộ đệm chuyển lên MỨC HTTP, đặt MỘT CHỖ trong
  /etc/nginx/conf.d/00-napp-proxy.conf. Trước đây mỗi vhost mang một bản sao
  trong 'location /' -> mỗi lần đổi phải sửa vhost, mà vhost là chỗ certbot
  chèn khối SSL, render lại là mất HTTPS.
- 'napp nginx sync' GỠ khối bộ đệm nội tuyến khỏi vhost cũ — BẮT BUỘC vì giá
  trị trong 'location' luôn thắng giá trị mức http, không gỡ thì site cũ vẫn
  16k và vẫn 502. Cắt theo DÒNG, không render lại vhost: khối SSL của certbot
  còn nguyên. Có sao lưu + hoàn tác nếu 'nginx -t' trượt.

## 1.19.0
- 'napp service create --run-as <domain|name>': worker chạy bằng USER CỦA APP
  WEB đã có thay vì user riêng. Cần khi worker đụng FILE của app (nén ảnh trong
  thư mục upload, thumbnail, dọn cache): thư mục app là 750 / file 640 của user
  app nên user riêng ĐỌC CÒN KHÔNG NỔI, mà nới quyền ra cho hai user là mở luôn
  cho mọi thứ khác. --run-as gỡ CẢ HAI lớp chặn: quyền Unix (thiếu -> EACCES)
  và sandbox systemd ProtectSystem=strict (thiếu -> EROFS dù ls -l trông đúng).
  Không truyền thì service vẫn có user riêng, cô lập như cũ.
- '--write-dir <path>' (lặp lại được): cấp quyền ghi vào đường dẫn ngoài mã
  nguồn service. Đường dẫn phải TỒN TẠI — systemd từ chối khởi động unit nếu
  ReadWritePaths trỏ vào chỗ không có, nên napp kiểm tra ngay lúc tạo.
- 'napp service set <name> [--run-as <u>|--standalone] [--write-dir <p>]': đổi
  danh tính/quyền ghi của service ĐÃ TẠO (chown mã nguồn, ghi lại unit,
  restart). Trước đây phải xoá đi tạo lại, mất .env.
- napp KHÔNG BAO GIỜ xoá user đi mượn: 'service remove --source' giữ user, và
  'app remove --source' từ chối xoá user khi còn worker đang mượn (kèm danh
  sách worker phải gỡ trước).
- ĐÁNH ĐỔI: dùng chung user = dùng chung DANH TÍNH UNIX. Worker đọc/ghi được
  mọi thứ của app web kể cả .env; một bên bị chiếm quyền là bên kia mất theo.
  Chỉ dùng cho hai nửa của CÙNG một sản phẩm.

## 1.18.0
- SỬA: Redis maxmemory-policy volatile-lru -> noeviction. BullMQ kiểm tra lúc
  kết nối và báo 'IMPORTANT! Eviction policy is volatile-lru. It should be
  "noeviction"'. Dữ liệu hàng đợi KHÔNG phải cache: job đang chờ, khoá, kết quả
  chỉ có một bản. Với chính sách *-lru, chạm maxmemory là Redis TỰ TRỤC XUẤT
  key — job bốc hơi giữa chừng, KHÔNG bên nào báo lỗi. volatile-lru cũng không
  thoát: BullMQ CÓ đặt TTL cho khoá, rate-limit, job đã xong. noeviction khiến
  Redis TỪ CHỐI lệnh ghi (OOM) khi đầy — hỏng lộ liễu hơn là mất việc trong im
  lặng. Chính sách áp cho CẢ INSTANCE, không tách theo DB index.
  Đánh đổi: Redis đầy thì ghi mới lỗi OOM chứ không tự dọn -> đặt TTL cho key
  cache (key hết hạn vẫn bị xoá) và theo dõi 'napp redis info'.
- 'napp check' đọc maxmemory-policy ĐANG CHẠY và báo nếu khác noeviction —
  server đã tune bằng bản cũ vẫn đang để volatile-lru, sinh lại template không
  chạm tới chúng. 'napp check --fix' áp ngay bằng CONFIG SET và ghi vào
  /etc/redis/conf.d/napp-tuning.conf (bền qua restart), KHÔNG restart Redis.

## 1.17.0
- ADDRESS_HEADER/XFF_DEPTH giờ là TUỲ CHỌN ('--address-header'), không còn mặc
  định. Chúng đổi thứ getClientAddress() của adapter-node trả về: từ ĐỊA CHỈ
  SOCKET sang giá trị PARSE TỪ HEADER — phá app nào tự phân giải IP khách (lấy
  socket peer, đối chiếu proxy tin cậy, RỒI mới tin header). Hệ quả: app spam
  log "ignoring forwarding headers from untrusted peer ..." mỗi request và rơi
  về tin bất cứ thứ gì XFF_DEPTH chọn. IP thường vẫn ra ĐÚNG, nên nguy hiểm:
  tính đúng đắn phụ thuộc hoàn toàn vào XFF_DEPTH khớp số hop thật, thêm một
  hop sau này là lặng lẽ đọc phải mục CLIENT GIẢ MẠO ĐƯỢC. Giá trị đó thường là
  khoá rate limiter -> hỏng nghĩa là đăng nhập sai KHÔNG GIỚI HẠN.
  App đã tạo không đổi gì; muốn gỡ thì xoá 2 dòng khỏi .env rồi 'napp app
  restart <domain>'.
- Sửa chú thích SAI về XFF_DEPTH: bản cũ ghi "có CDN trước nginx thì tăng lên
  2". Sai khi nginx đã bật Cloudflare real-IP — $remote_addr ĐÃ là IP khách
  thật nên $proxy_add_x_forwarded_for nối thêm chính nó, vẫn là 1.

## 1.16.0
- 'napp app set <domain>': ĐỔI CẤU HÌNH NGINX CỦA APP ĐÃ TẠO. Các tuỳ chọn thêm
  ở 1.15.0 (--static-root/--upload-dir/--hotlink-protect/--max-body) trước đó
  chỉ áp dụng lúc TẠO app; 'napp nginx sync' không giúp được vì nó chỉ vá đúng
  một chuỗi chứ không render lại vhost — cố ý như vậy, vì certbot chèn khối SSL
  thẳng vào vhost nên render lại là xoá HTTPS đang chạy.
- Location riêng của app chuyển sang FILE INCLUDE
  (/etc/nginx/napp-locations/<domain>.conf): vhost chỉ mang ĐÚNG MỘT dòng
  include, nên mọi lần đổi cấu hình về sau chỉ ghi lại một file và KHÔNG BAO
  GIỜ chạm vào vhost. Dòng include được chèn vào khối server đang proxy tới
  upstream của app (dò bằng đếm ngoặc), một lần duy nhất, idempotent, có sao
  lưu + hoàn tác nếu 'nginx -t' trượt.
- SỬA: 'napp domain add/remove' âm thầm làm MẤT HTTPS — regenerateNginxConf ghi
  đè toàn bộ vhost nên khối SSL của certbot biến mất, site tụt về HTTP mà không
  báo gì. Nay có cảnh báo rõ kèm lệnh cấp lại, và sao lưu + hoàn tác.
- SỬA: app tạo bằng bản cũ có thể làm SẬP NGINX TOÀN MÁY — vhost nay include
  file location, mà nginx từ chối khởi động nếu include trỏ vào file không tồn
  tại. 'app create' và 'napp domain' đều ghi file này TRƯỚC khi ghi vhost, kể cả
  khi app không bật tuỳ chọn nào. 'app remove' và rollback đều dọn file.
- NginxAppOptions không còn bản sao của staticRoot/uploadDir/hotlink* — chúng
  chỉ nằm trên AppRecord, tránh dựng lại cái bẫy "tham số không ai đọc".

## 1.15.0
- CẶP WEB + WORKER DÙNG CHUNG REDIS DB: '--share-redis-with <domain|name>' và
  '--redis-db <n>'. Trước đây '--redis' luôn cấp index rảnh kế tiếp, nên web app
  và worker ra HAI DB khác nhau. Hàng đợi chỉ chạy khi bên đẩy và bên tiêu thụ
  nhìn CÙNG keyspace: khác DB thì web đẩy job vào #1, worker nghe #2, KHÔNG BÊN
  NÀO BÁO LỖI — job chất đống, email/thông báo/resize im lặng không chạy. Tạo
  service với '--redis' mà không chỉ định dùng chung thì napp cảnh báo tại chỗ.
  Xoá một đơn vị KHÔNG còn trả index về danh sách trống khi đơn vị khác vẫn dùng.
- '--static-root <dir>' + '--static-prefix <path...>': để NGINX trả asset thay vì
  Node. Vhost trước đây không có 'root' nào nên MỌI file (.js/.css/.woff2) đều đi
  qua Node — một trang SSR/SPA kéo hàng trăm chunk, tất cả xếp hàng trên event
  loop đơn luồng và tranh với chính việc render. Chỉ phục vụ theo TIỀN TỐ khai
  báo (SvelteKit /_app/ · Next.js /_next/static/ · Vite /assets/), không dùng
  try_files chung cho 'location /'.
- '--upload-dir <dir>' (+ '--upload-prefix', mặc định /uploads/): FILE NGƯỜI
  DÙNG TẢI LÊN không phải asset build, '--static-root' KHÔNG thay được. Với
  SvelteKit adapter-node, 'static/' được SAO CHÉP vào build/client LÚC BUILD và
  lúc chạy server chỉ phục vụ build/client — nên ảnh tải lên SAU khi build trả
  404 dù file có thật trên đĩa, rồi TỰ NHIÊN hiện ra sau lần deploy kế tiếp (vì
  build lại sao chép static/), trông như lỗi chập chờn chứ không như lỗi cấu
  hình. Cache-Control ở đây cố ý NGẮN (1 ngày) và KHÔNG 'immutable': tên file
  tải lên không băm nội dung nên cùng một URL có thể đổi nội dung.
- '--hotlink-protect' (+ '--hotlink-allow <domain...>'): chỉ cho nhúng ảnh
  trong --upload-dir từ domain của site. Dùng 'valid_referers ... server_names'
  nên thêm domain phụ là tự động được phép. 'none' và 'blocked' ĐƯỢC PHÉP có
  chủ đích: 'none' gồm cả bot lấy ảnh xem trước khi chia sẻ link (Facebook/
  Zalo/Telegram thường không gửi Referer) — chặn nó là mất ảnh preview ở mọi
  link chia sẻ. GIỚI HẠN: Referer do trình duyệt tự khai (trang hotlink đặt
  <meta name="referrer" content="no-referrer"> là qua được) nên đây chặn
  hotlink TUỲ TIỆN chứ không phải kiểm soát truy cập; và nếu có CDN đứng trước
  thì CDN cache theo URL, không quan tâm Referer, nên chỉ tác dụng với lần
  cache MISS — muốn chặn thật phải bật ở tầng CDN.
- '--max-body <size>' THỰC SỰ có tác dụng: client_max_body_size vẫn luôn là 20M
  vì không chỗ gọi nào truyền tham số đã có sẵn -> upload lớn hơn bị chặn 413
  trước khi tới app. Nay giá trị nằm trong bản ghi app, template đọc thẳng từ đó.
- '--app-dir <path>': chạy được app trong MONOREPO. WorkingDirectory và
  EnvironmentFile trỏ vào thư mục con thay vì gốc repo. Với pnpm, chạy từ gốc
  repo khiến một gói CÓ THẬT vẫn báo ERR_MODULE_NOT_FOUND (Node đi ngược lên từ
  file gọi, pnpm chỉ symlink vào node_modules của package đó); và vì
  EnvironmentFile có tiền tố '-', .env sai chỗ khiến app khởi động RỖNG biến môi
  trường mà không in lỗi. ReadWritePaths vẫn là GỐC mã nguồn.
- 'gzip_proxied any' trong napp-tuning.conf. Chỉ thị này áp dụng khi REQUEST CỦA
  CLIENT mang header 'Via' (không phải "phản hồi từ upstream"). Đo trên trang
  132 KB: không Via thì cả hai đều nén; CÓ Via thì thiếu dòng này trả nguyên
  132 KB. Cloudflare không gửi Via, nhưng Fastly/Varnish/squid thì có.
- Bộ đệm proxy đủ cho trang SSR: proxy_buffer_size 8k->16k, proxy_buffers
  8x8k -> 16x16k. Phần vượt bộ đệm bị nginx ghi ra FILE TẠM trên đĩa rồi đọc
  lại, mỗi request một lần.
- App/service ĐÃ TẠO không đổi hành vi. Áp phần nginx cho app đang chạy:
  'napp nginx sync'.

## 1.14.0
- Thêm 'napp doctor' — soi RỦI RO BẢO MẬT (khác 'napp check' vốn chỉ hỏi môi
  trường đã ĐỦ chưa). Có trong menu tương tác, mục 9.
- 'napp doctor system': liệt kê gói có BẢN VÁ BẢO MẬT đang chờ (đọc từ kho
  '-security' của apt, đánh dấu gói trọng yếu: nginx/OpenSSL/OpenSSH/libc/
  MariaDB/Redis/Node.js/certbot); phát hiện dịch vụ ĐÃ VÁ NHƯNG CHƯA RESTART
  (còn nạp thư viện cũ trong RAM — đọc /proc/<pid>/maps tìm file '(deleted)',
  không cần cài needrestart); đối chiếu phiên bản nginx với bảng CVE nổi bật
  (CVE-2021-23017 RCE qua resolver, HTTP/2 Rapid Reset, module mp4, mTLS
  session resumption...); cảnh báo Node.js đã EOL (hết nhận bản vá); báo khi
  máy cần reboot.
- CVE của nginx được KẾT LUẬN BẰNG BẰNG CHỨNG trên máy, không chỉ so số phiên
  bản: '[ĐÃ VÁ]' khi mã CVE có trong changelog của gói đã cài (bản vá backport
  luôn ghi mã CVE vào /usr/share/doc/nginx-*/changelog.Debian.gz, đọc offline);
  '[KHÔNG DÍNH]' khi module không được biên dịch vào ('nginx -V') hoặc cấu hình
  đang chạy không kích hoạt phần đó ('nginx -T': không mp4, không HTTP/2, không
  resolver, không ssl_verify_client); chỉ báo động khi KHÔNG chứng minh được là
  đã xử lý, kèm lý do còn thiếu bằng chứng nào và lệnh kiểm chứng thủ công.
  Lý do: Ubuntu/Debian vá ngược mà giữ nguyên số upstream, nên nginx 1.24.0 đã
  vá và chưa vá nhìn giống hệt nhau — chỉ so số thì báo động mãi không tắt kể
  cả sau khi đã 'apt upgrade'. Có in kèm phiên bản GÓI (vd 1.24.0-2ubuntu7.5).
- 'napp doctor deps [<domain|name>]': quét rủi ro CHUỖI CUNG ỨNG (dependency
  chain attack) trong mã nguồn từng app/service — thiếu lockfile, dependency
  '*'/'latest', dependency trỏ thẳng git/URL (không có hash toàn vẹn), tên gần
  giống package phổ biến (typosquat), package chạy script khi cài
  (preinstall/install/postinstall), lỗ hổng đã công bố qua audit của chính
  package manager (npm/pnpm/yarn/bun), .npmrc chứa token quyền quá rộng. Mỗi
  phát hiện đều kèm CÁCH XỬ LÝ cụ thể. Thêm '--deep' để tra ngày phát hành của
  dependency trực tiếp trên registry npm (gói bị chiếm thường chỉ sống vài giờ
  tới vài ngày trước khi bị gỡ).
- Output của doctor phân màu theo mức độ: ĐỎ ĐẬM cho NGHIÊM TRỌNG, ĐỎ cho CAO
  (tô cả nội dung, không chỉ nhãn), vàng cho TRUNG BÌNH, xám cho phần tham
  khảo. Gói trọng yếu trong danh sách bản vá được đánh dấu '!' màu đỏ. Thêm mức
  log '[NGUY HIỂM]' (đỏ đậm) cho cảnh báo bảo mật, tách khỏi '[CẢNH BÁO]' vàng
  vốn dùng cho việc vận hành thường.
- 'napp doctor upgrade': LẤY BẢN VÁ VỀ — mặc định chỉ cài bản vá BẢO MẬT
  ('--all' cho mọi cập nhật, '--only nginx' cho một gói). Dùng --force-confold
  nên KHÔNG ghi đè cấu hình đang chạy và không treo ở prompt của dpkg; nâng cấp
  nginx thì chạy 'nginx -t' TRƯỚC khi restart (cấu hình sai thì dừng, không làm
  sập site); sau khi cài chỉ restart đúng những dịch vụ còn nạp thư viện cũ.

## 1.13.1
- Background service KHÔNG còn nằm ở /srv/napp nữa: mã nguồn chuyển về CHUNG
  /var/www với app web để khỏi phân mảnh thư mục và khỏi đi tìm nhiều nơi.
  Phân biệt bằng HẬU TỐ tên thư mục: app web giữ tên domain
  (/var/www/api.example.com), service thêm '-service'
  (/var/www/queue-email-service). Nằm trong /var/www KHÔNG làm service public —
  nginx chỉ phục vụ thư mục nào có vhost trỏ tới, mà service thì không có vhost.
- Áp dụng cho service TẠO MỚI. Service tạo bằng bản cũ vẫn chạy đúng thư mục cũ
  (napp đọc đường dẫn từ registry). Muốn dời sang chỗ mới:
    sudo systemctl stop napp-svc-<name>
    sudo mv /srv/napp/<name> /var/www/<name>-service
    sudo sed -i 's#/srv/napp/<name>#/var/www/<name>-service#g' \\
      /etc/napp/state.json /etc/systemd/system/napp-svc-<name>.service
    sudo systemctl daemon-reload && sudo systemctl start napp-svc-<name>
- Chặn đặt tên service kết thúc bằng '-service' (napp tự thêm hậu tố này) và
  chặn tạo service trùng thư mục với một app web đang có trong registry.

## 1.13.0
- Thêm BACKGROUND SERVICE — ứng dụng Node.js/Bun chạy NGẦM (worker, bot, queue
  consumer, cron poller): KHÔNG domain, KHÔNG nginx/SSL. Nhóm lệnh mới
  'napp service' (create/deploy/remove/list/restart/stop/start/logs/env-set),
  cũng có trong menu tương tác. Mỗi service vẫn có user hệ thống riêng, unit
  systemd (hardening + tự restart), tuỳ chọn --db/--redis, và clone repo private
  qua --token/--ssh-key y như app web.
- Cổng là TUỲ CHỌN cho service: mặc định KHÔNG cấp cổng (worker thuần không
  listen gì). Truyền --port khi service tự bind (health-check/socket) — vẫn
  không public qua nginx.
- Lệnh khởi động đặt tự do qua --start-cmd cho cả framework khác nhau (Express:
  'node src/index.js'; SvelteKit adapter-node: 'node build/index.js'; hoặc
  worker: 'node worker.js'). Mặc định 'npm start' theo package.json.
- Heap V8 nay chia cho TỔNG số đơn vị chạy Node (app web + service) để tổng heap
  không vượt RAM khi có thêm worker. Tự cân đối lại khi tạo/xoá service và khi
  'napp tune apply'. Namespace tách biệt: service dùng user 'nas_*', unit
  'napp-svc-*', mã nguồn ở /var/www/<name>-service — không đụng tài nguyên app web.

## 1.12.2
- Sửa lỗi tạo app runtime bun THẤT BẠI khi repo mang lockfile của trình khác
  (pnpm-lock.yaml / package-lock.json / yarn.lock): bun migrate sang bun.lock
  (=thay đổi lockfile) rồi bị chặn "lockfile had changes, but lockfile is
  frozen" nếu frozen bật (bunfig.toml, biến CI). Nay lệnh cài của bun đã
  "lockfile-aware": có bun.lock -> cài frozen (tất định); không có -> ép
  --no-frozen-lockfile để bun được phép ghi lock migrate. Cùng nếp với
  pnpm/yarn/npm (đều có fallback khi lock lệch).

## 1.12.1
- Phát hành lại (republish) — không đổi tính năng, chỉ tăng version để đẩy bản
  cập nhật qua 'napp update'.

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

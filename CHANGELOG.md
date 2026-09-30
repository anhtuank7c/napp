# Changelog

Tất cả thay đổi đáng chú ý của `napp` được ghi lại ở đây.

## 1.30.1

- **Gợi ý phím luôn nhìn thấy được, và nói đúng Esc làm gì ở màn hình đó:** `Esc quay lại` ở menu con, `Esc thoát napp` ở menu chính, `Esc huỷ` trong danh sách chọn, `Esc ở lại` trong câu hỏi thoát. Tên phím in đậm màu thay vì làm mờ cả dòng (nhiều terminal SSH hiển thị chữ mờ gần như vô hình). Terminal hẹp thì bỏ bớt gợi ý ít quan trọng — gợi ý Esc không bao giờ bị cắt.

- **Esc (hoặc Ctrl+C) ở menu chính hỏi "Thoát napp?" với Có/Không**, mặc định **Không**: Enter hoặc Esc là ở lại, chọn "Có" mới thoát. Ctrl+C thêm lần nữa ngay tại câu hỏi này = thoát. Chọn "0. Thoát napp" vẫn thoát ngay (đó là chủ đích rõ ràng).

## 1.30.0

- **Chọn bằng phím mũi tên ở mọi nơi trong menu:** `↑`/`↓` di chuyển, `Enter` chọn, `Esc` quay lại. Danh sách nhiều lựa chọn (database engine cần có, những gì xoá kèm khi gỡ app/service, lần đầu chọn engine trong `check --fix`) dùng `Space` để tick/bỏ tick, `a` để tick/bỏ tất cả, `Enter` xác nhận. Áp dụng cho mọi menu, mọi danh sách chọn một (app, service, database, engine, runtime, package manager...) và mọi danh sách chọn nhiều.

- **Thói quen cũ vẫn dùng được:** gõ số để nhảy tới mục đó (gõ liền hai chữ số cho mục từ 10 trở lên), `0` nhảy tới "Quay lại"/"Thoát". Quay lại một menu thì con trỏ đứng đúng mục vừa dùng. Danh sách dài hơn màn hình được cuộn theo con trỏ.

- **Esc ở menu chính KHÔNG thoát** (chỉ nhắc chọn "0. Thoát napp"); Esc trong một danh sách chọn = huỷ thao tác đó.

- Không phải terminal thật (chạy qua pipe/script) thì vẫn là kiểu gõ số như trước — tự động hoá không bị ảnh hưởng. Terminal luôn được trả về chế độ thường sau mỗi lần chọn, kể cả khi huỷ, nên lệnh chạy sau đó (git, apt...) vẫn nhận Ctrl+C bình thường.

- Viết tay, **không thêm thư viện nào**: napp vẫn là một file duy nhất chạy bằng root — không thêm mắt xích chuỗi cung ứng.

## 1.29.1

- **Sửa lỗi nguy hiểm: `check --fix` có thể GỠ MySQL đang chạy.** Máy chưa từng chọn engine thì napp mặc định MariaDB; nếu máy đang có MySQL cài tay, `--fix` "sửa" MariaDB còn thiếu bằng `apt-get install -y mariadb-server` — apt gỡ MySQL để nhường chỗ và MariaDB tiếp quản `/var/lib/mysql`. Kiểm tra cổng chỉ chặn được khi MySQL đang chạy. Nay driver MariaDB/MySQL **từ chối cài** khi máy đang có bên kia (chặn ở mọi đường cài, không chỉ `check`), còn `check` báo rõ tình huống và chỉ lệnh dùng engine đang có (`napp db engine set mysql`) — không đưa ra fix tự động.

- **`check --fix`: một mục lỗi không còn chặn các mục sau.** Trước đây cài MongoDB thất bại (vd CPU thiếu AVX) là dừng luôn, fail2ban/UFW/Redis phía sau không được cài. Nay mỗi mục chạy riêng, cuối cùng có tổng kết: đã sửa / không sửa được (kèm lý do) / cần xử lý tay. Câu hỏi xác nhận chỉ đếm những mục napp thật sự tự sửa được. Vừa cài database engine thì nhắc chạy `tune apply` để chia lại RAM.

- **Menu "Kiểm tra & sửa môi trường" theo sát lựa chọn database:** đầu màn hình hiện từng engine cần có kèm trạng thái (● đang chạy / ○ đã dừng / ✗ chưa cài), engine đã cài nhưng napp không quản lý, hoặc "không dùng database". Mục mới **"Chọn database engine cần có trên máy"**: tick/bỏ tick — tick thêm là cài luôn; bỏ tick một engine đang cài thì hỏi *gỡ khỏi máy* (dữ liệu giữ lại) hay *chỉ ngừng quản lý*; bỏ hết = không dùng database. Chọn cả MariaDB lẫn MySQL bị từ chối ngay.

## 1.29.0

- **Menu chia theo ngữ cảnh:** chọn **thứ** muốn làm việc trước, rồi mọi thao tác trên nó nằm cùng một chỗ. Chọn một app là vào **menu của riêng app đó** (xem · deploy · restart · dừng/khởi động · log · biến môi trường · domain phụ · SSL · nginx · leak guard · chụp heap · xoá) — không còn cảnh chọn "Restart" rồi chọn app, chọn "Log" rồi chọn lại đúng app đó. Service cũng vậy, kèm "Danh tính & quyền ghi" (run-as, write-dir).

- **Bỏ nhóm "Hạ tầng" 17 mục.** Tách thành **Bảo mật** (tường lửa, fail2ban, hardening, chặn quét, doctor) và **Hiệu năng & nginx** (tối ưu, đồng bộ nginx, IP Cloudflare, bộ nhớ). Mỗi màn hình tối đa khoảng 8 mục.

- **Công tắc là MỘT mục, hiện trạng thái thật** — `[BẬT]` / `[TẮT]` đọc lại mỗi lần vẽ menu; chọn là đảo (có hỏi xác nhận). Thay cho các cặp "Bật X" / "Gỡ X" rời rạc không cho biết X đang bật hay tắt.

- **"Tác vụ định kỳ"**: backup hàng ngày, cập nhật IP Cloudflare, lấy mẫu bộ nhớ nằm chung một chỗ, mỗi dòng kèm trạng thái, lịch và lần chạy tới. Menu chính hiện luôn có bao nhiêu tác vụ đang bật.

- **Menu làm được gần hết những gì CLI làm được** — trước đây thiếu: dừng/khởi động, biến môi trường, domain phụ, xem chi tiết app/service, đổi danh tính service, xoá database, đặt engine mặc định, xoá dữ liệu Redis DB, leak guard, chụp heap, gỡ chặn IP fail2ban, `check --fix`.

- **Mỗi thao tác in lệnh CLI tương đương** (`Lệnh tương đương: sudo napp …`) để người dùng menu học dần được lệnh.

## 1.28.1

- **Sửa lỗi nặng: menu napp tự tắt không một lời** ngay sau khi một lệnh hỏi xác nhận (Áp tối ưu phần cứng, Xoá app, Gỡ SSL, Xoá database...). Nguyên nhân: mỗi lệnh tự mở một bộ đọc stdin riêng trong khi menu vẫn giữ bộ đọc của nó — bộ đọc kia nuốt mất câu trả lời, rồi khi đóng nó **dừng stdin**, không còn gì giữ tiến trình sống và Node thoát với **mã 0**, không lỗi, không thông báo. Đã tái hiện được, và đã kiểm chứng bản cũ chết đúng như vậy còn bản mới trả lời xong quay lại menu. Nay mọi câu hỏi (menu lẫn trong lệnh) đi qua một chỗ duy nhất (`lib/prompt.ts`).

- **Lệnh bên thứ ba thất bại không còn đá bạn khỏi napp.** Lỗi được in rõ bằng `[LỖI]` kèm cách sửa, rồi quay lại menu. Thông báo cũng nói được nhiều hơn "mã 1": thiếu chương trình -> nói tên chương trình và cách cài; bị Ctrl+C -> nói là bị ngắt; lệnh nhận dữ liệu qua stdin (vd SQL gửi vào `mysql`) -> in lại **chính thông báo lỗi của lệnh đó** (trước đây bị nuốt mất); lỗi quyền (`EACCES`) -> bảo mở bằng `sudo napp`; hết đĩa -> cách dọn. Lỗi thật của napp được gọi đúng tên, kèm vài dòng stack để báo lại.

- **Ctrl+C khi `git`/`apt`/`certbot` đang treo nay ngắt được lệnh đó** và napp quay lại menu. Trước đây terminal bị giữ ở raw mode suốt phiên menu nên Ctrl+C không tới được lệnh con (và lệnh con hỏi gì cũng không hiện chữ gõ vào). Ctrl+C tại một câu hỏi = huỷ thao tác đó; ở menu con = về menu chính; ở menu chính phải bấm **hai lần** trong 3 giây mới thoát.

- **Chỉ thoát napp khi chủ đích chọn `0`** (hoặc `q`). Trước đây bấm Enter trống ở menu chính cũng thoát. Lựa chọn sai được báo lại thay vì lặng lẽ vẽ lại menu. Stdin đóng (SSH rớt, Ctrl+D) thì thoát **có lời**.

- Chạy lệnh trực tiếp (không qua menu) mà huỷ tại câu hỏi xác nhận: thoát mã 130 với thông báo rõ, không còn trông như một vụ sập.

## 1.28.0

- **Mọi lệnh theo một khuôn, như gọi REST API:** `napp <resource> [<sub-resource>] <verb> [<id>] [--flags]`. Đọc tên một lệnh là đoán được các lệnh còn lại. Trước đây cùng một ý có nhiều động từ — tạo là `create`/`add`/`issue`, xoá là `remove`/`drop`/`revoke`, sửa là `set`/`env-set`/`apply`/`sync`/`setup`, xem là `list`/`status`/`info`/`allocations`/`trend` — và công tắc bật/tắt có tới bốn hình dạng (`harden`/`unharden`, `scanblock`/`unscanblock`, `watch`/`unwatch`, `schedule`/`unschedule`).

- **Bộ động từ cố định:** `list` · `show <id>` · `create <id>` · `update <id>` · `delete <id>` · `set`/`unset` (env, danh sách engine) · `enable`/`disable` (**mọi** công tắc) · `apply` (đồng bộ). Hành động riêng chỉ có: `deploy start stop restart logs` · `renew` · `flush` · `snapshot sample` · `unban`.

- **Quy ước cờ:** `-y/--yes` = bỏ xác nhận, ở mọi lệnh; `--force` chỉ để vượt qua một lần từ chối vì an toàn; cờ bật/tắt đi thành cặp `--x`/`--no-x`. `--db` giờ **chỉ** có nghĩa "tạo database" (trên `create`) — xoá kèm database là `--database` (trước đây `app remove --db` nghĩa ngược lại). `backup … --keep` đổi thành `--keep-count` cho đi cặp với `--keep-days`.

- **Tài nguyên con về đúng chỗ:** domain phụ là `app alias list|create|delete` (không còn là lệnh `domain` riêng); biến môi trường là `app env list|set|unset` và `service env …`; `db backup` gộp vào `backup create --database`; Redis DB index là `redis db list|flush`.

- **Lệnh mới:** `app show` / `service show` (cấu hình + trạng thái một đơn vị); `app|service env list [--reveal]` (giá trị bí mật bị che) và `env unset`; `show` cho mọi công tắc — `backup schedule show`, `cloudflare schedule show`, `mem watch show` (lịch, lần chạy tới/trước, lệnh thật sự được chạy), `nginx hardening show`, `nginx scan-block show`.

- **Tên cũ vẫn chạy** (ẩn khỏi `--help`, in một dòng nhắc tên mới — CHỈ khi gõ trong terminal, không làm bẩn journal của timer) và sẽ bỏ ở 2.0. **Ngoại lệ vĩnh viễn:** `backup run`, `cloudflare sync`, `mem sample` — unit systemd napp đã ghi lên server gọi đúng các tên đó. Unit tạo từ bản này dùng tên mới; `napp check` báo (không phải lỗi) unit nào còn gọi tên cũ. Bảng đối chiếu đầy đủ ở README, mục "Tên lệnh trước 1.28".

- **Cố ý đổi hành vi:** `napp backup schedule`, `napp cloudflare schedule`, `napp mem watch` gõ **không kèm gì** trước đây = bật lịch với giá trị mặc định; nay dừng với mã lỗi và in các lệnh con — gõ để xem có gì mà âm thầm tạo timer là đúng loại bất ngờ cần bỏ. Kèm cờ kiểu cũ (`--time …`) thì vẫn chạy như trước.

## 1.27.0

- **Tự chọn database engine: MariaDB (mặc định), MySQL, PostgreSQL, MongoDB — cài một, vài, hoặc không cài gì.** Trước đây `napp check --fix` luôn cài MariaDB. Nay lựa chọn được lưu trong `/etc/napp/state.json`; chưa từng chọn thì vẫn là MariaDB, nên **nâng cấp napp không thay đổi gì trên server đang chạy**, và app tạo bằng bản cũ được hiểu là dùng MariaDB.

- **Chọn lúc cài:** `curl ... | sudo NAPP_DB=postgresql bash` (qua `curl | bash` thì không hỏi được, nên chọn bằng biến môi trường), hoặc `napp check --fix --db postgresql` (`none` = không dùng database; nhiều engine cách nhau dấu phẩy). Lần đầu chạy `check --fix` trên máy chưa có engine nào, napp sẽ **hỏi**.

- **`napp db engine list | add | remove | default | select`** — thêm, gỡ, xem engine nào đang được app nào dùng. `--db [engine]` trên `app create` / `service create`, `--engine` trên `db create|drop|list|backup` và `backup run`. Chỉ ghi `--db` trống: dùng engine mặc định, hoặc engine duy nhất đang có; máy có nhiều engine mà không chỉ định thì napp **dừng lại bắt chọn** chứ không đoán — tạo nhầm engine là app kết nối sai mà không báo gì cho tới lúc chạy.

- **`.env` có thêm `DATABASE_URL`** (Prisma, Drizzle, TypeORM, Knex, Mongoose đều đọc thẳng). Các biến `DB_*` cũ vẫn giữ; `DB_CONNECTION` là `mysql` / `pgsql` / `mongodb`.

- **MariaDB và MySQL bị chặn không cho cài cùng nhau**: gói apt xung đột, cùng cổng 3306, cùng `/var/lib/mysql` — cài cái sau là apt gỡ cái trước, kèm nguy cơ mất dữ liệu.

- **Sửa lỗi ngầm: RAM dành cho database bị giữ chỗ kể cả khi máy KHÔNG có database.** `nodeHeapPlan` luôn trừ 25–50% RAM cho DB, nên máy không cài MariaDB vẫn bị bóp heap V8 vô cớ (máy 4GB: web app 524 MB thay vì 1179 MB). Nay phần đó theo đúng số engine đang chạy — **0 engine = 0%** — và là **TỔNG** cho mọi engine (hai engine chia đôi) chứ không cộng dồn, không thì hai engine đã nuốt gần hết RAM. Chạy `sudo napp tune apply` để áp.

- **Gỡ engine an toàn theo mặc định:** từ chối khi còn app/service dùng nó; còn database không gắn với app nào thì cần `--force` và napp **dump toàn bộ** trước khi gỡ (dump lỗi = không gỡ); `apt remove` giữ nguyên dữ liệu; chỉ `--purge` mới xoá thư mục dữ liệu, và phải gõ tên engine để xác nhận. Engine đã gỡ **không bị `check --fix` cài lại**.

- **PostgreSQL** từ kho Ubuntu (không thêm PGDG — bản vá đi theo `apt upgrade` và `napp doctor` đọc được). Quản trị qua peer auth (`sudo -u postgres`), không lưu mật khẩu superuser ở đâu. Mỗi app một role sở hữu database của mình, `REVOKE CONNECT` khỏi PUBLIC. Tuning ghi vào `conf.d/` của cluster.

- **MongoDB 8.0** từ kho chính thức. Ba cái bẫy được chặn sẵn: CPU không có **AVX** (mongod chết ngay bằng `Illegal instruction` — napp kiểm tra trước khi cài); **xác thực tắt theo mặc định** (napp bật ngay, cả khi nhận quản lý một MongoDB đã cài tay); **cache WiredTiger mặc định 50% RAM − 1GB** bóp chết các app Node (napp đặt theo ngân sách). Mật khẩu quản trị không bao giờ nằm trong argv — script mongosh và cấu hình mongodump đều đi qua file `0600`.

- **Kiểm tra trước khi cài engine:** cổng mặc định đã bị chiếm (hay gặp nhất: container Docker publish 5432/3306, hoặc một database cài tay) thì napp **dừng lại và nêu tên tiến trình** — thay vì để apt cài xong rồi service không khởi động được, lý do thật chôn trong `journalctl`. Thiếu đĩa cũng dừng trước khi apt chạy: hết đĩa giữa chừng để dpkg ở trạng thái hỏng.

- **Chờ apt thay vì chết:** VPS mới khởi động có unattended-upgrades giữ khoá dpkg vài phút — mọi `apt-get install` lúc đó lỗi `Could not get lock` ngay, và đó là thứ người dùng gặp **đầu tiên** khi thử napp trên máy mới. Mọi lệnh apt của napp (kể cả `check --fix`, `doctor upgrade`) nay đợi tối đa 5 phút và nói rõ đang đợi tiến trình nào.

- **`napp check` / `napp doctor` cảnh báo database lắng nghe ra ngoài 127.0.0.1** (kể cả engine napp không quản lý, và cổng X Protocol 33060 của MySQL) — chỉ ra đúng dòng cấu hình cần sửa. Cố ý không có `--fix`: có thể người dùng mở có chủ đích, sửa sai là cắt kết nối của thứ gì đó ngoài máy.

- **Backup tách thư mục theo engine** (`/var/backups/napp/db/<engine>/`); một engine lỗi không chặn backup của engine khác. Bản backup phẳng từ bản cũ vẫn hết hạn theo cùng chính sách. **Sửa lỗi:** dump dùng `set -o pipefail` — trước đây `mysqldump` thất bại vẫn để lại một file `.sql.gz` rỗng và báo thành công.

## 1.26.0

- **`napp mem`: phát hiện rò rỉ bộ nhớ *trước* khi app chết** — và chụp heap để tìm thủ phạm. Không sửa một dòng code nào của app.

- **Tín hiệu đã nằm sẵn ở đó từ đầu.** Mọi unit napp đều có `Restart=always`, nên app rò rỉ chạm trần heap sẽ **chết** rồi được systemd **lặng lẽ khởi động lại** — lặp đi lặp lại nhiều ngày mà không ai hay. systemd đã đếm sẵn số lần đó (`NRestarts`), chỉ là chưa ai đọc ra. `napp mem status` và `napp check` nay đọc ra.

- **`napp mem watch`** — systemd timer lấy mẫu định kỳ (mặc định 15 phút); `napp mem trend` kết luận xu hướng.

- **Đo `anon` trong `memory.stat`, không đo `memory.current`.** `memory.current` gồm cả **page cache** — thứ phình ra co lại theo I/O của cả máy, đủ nhiễu để dìm chết tín hiệu thật.

- **Ba quy tắc để không kêu oan** (kêu oan vài lần là người dùng học cách phớt lờ mọi cảnh báo): chỉ xét đoạn **từ lần restart gần nhất** (ghép hai bên một lần restart cho ra dốc âm vô nghĩa, che mất chính cái rò rỉ đã gây ra nó); so **trung vị** hai phần tư đầu/cuối chứ không so mẫu đầu với mẫu cuối; **dưới 6 giờ dữ liệu thì không kết luận gì** — RSS của Node luôn tăng lúc đầu rồi đi ngang vì V8 không trả bộ nhớ về OS sớm.

- **`napp mem guard <app>`** thêm `--heapsnapshot-near-heap-limit=1` và `--heapsnapshot-signal=SIGUSR2` vào `NODE_OPTIONS`. Cờ đầu khiến Node **tự chụp heap ngay trước khi chạm trần**, thay vì chết mà không để lại gì. **`napp mem snapshot <app>`** chụp tiến trình đang chạy, app vẫn sống — và **chờ tới khi file ngừng tăng kích thước** rồi mới báo xong, vì không có bước đó thì rất dễ đem đi phân tích một file mới ghi được một nửa.

- **An toàn: `SIGUSR2` giết tiến trình Node nếu cờ chưa có hiệu lực** (hành vi mặc định của tín hiệu). napp đọc `/proc/<pid>/environ` để xác nhận cờ **thật sự đang chạy** rồi mới dám gửi, và **từ chối** nếu không chắc. Đọc môi trường thật chứ không đọc file unit — vì `.env` của app ghi đè được `NODE_OPTIONS`.

- **Sửa lỗi nặng: `Environment=NODE_OPTIONS=…` không được bọc nháy kép.** systemd tách directive này theo **dấu cách**, nên nhiều cờ bị hiểu thành nhiều phép gán và **mọi cờ sau cờ đầu tiên bị vứt đi** — bằng chứng duy nhất là một dòng `Invalid environment assignment, ignoring` trong journal mà không ai đọc. Trước bản này chỉ có đúng một cờ nên lỗi chưa lộ; thêm cờ thứ hai là lộ ngay. Đã kiểm chứng trên systemd thật: trước khi sửa tiến trình chỉ nhận `--max-old-space-size`, sau khi sửa nhận đủ cả ba.

- **Số đo thật về chi phí chụp heap** — đừng chụp app web vào giờ cao điểm: file lớn khoảng **gấp đôi heap** và mất **vài phút** để ghi (`heap 96 MB → 184 MB, 176 giây`; `128 MB → 237 MB`). Node **luôn** ghi vào thư mục làm việc của app, không đổi được chỗ. Dừng/restart đơn vị giữa chừng cho ra file **cụt** (đã kiểm chứng: 0 byte).

- `napp check` báo thêm ba thứ: đơn vị bị systemd khởi động lại, đơn vị có bộ nhớ tăng liên tục, và file `.heapsnapshot` còn sót trong thư mục app.

- **Cố ý không biến napp thành APM.** Cần quan sát thật sự thì `prom-client` + Prometheus/Grafana mới đúng công cụ. Và tuyệt đối không dùng `--inspect` trên production — nó mở cổng debugger, ra tới Internet là tương đương RCE.

## 1.25.0

- **Web app được ưu tiên hơn background service.** Trước đây napp đối xử với hai loại này **hoàn toàn như nhau**: cùng phần heap, và không có ưu tiên CPU nào cả. Nghĩa là một worker cron chạy mỗi giờ được đúng bằng heap của web app đang phục vụ traffic — và một worker nén ảnh tranh CPU **ngang cơ** với nó.

- **Heap V8 chia theo trọng số.** Mẫu số nay là `số app + số service × 0.5` thay vì tổng số đơn vị. Tổng RAM cấp phát **không đổi**, chỉ phân bổ lại về phía traffic. Máy 4 GB, 2 app + 2 service: trước cả bốn được **327 MB**; nay web **436 MB**, service **218 MB** (tổng vẫn 1308 MB). Đổi tỷ lệ bằng `napp tune apply --service-weight <0.1–1>` (`1` = chia đều như trước).

- **Nhưng heap là lớp yếu nhất — đừng trông chờ vào nó.** `--max-old-space-size` là một **trần**, không phải RAM đặt trước: cho web app heap lớn hơn *không* lấy đi gì của worker, nó chỉ cho web app lớn thêm trước khi thrash GC hoặc chết.

- **`CPUWeight` mới là lớp người dùng thật sự cảm nhận được** (web 200 / service 50). Một worker sharp/ffmpeg chiếm hết lõi làm mọi request chậm hẳn, và không con số heap nào đổi được điều đó dù một mili-giây. `CPUWeight` là tỷ lệ chia **chỉ áp dụng khi có tranh chấp** — worker rảnh thì web app vẫn dùng 100% CPU như thường. Đo trên máy thật, hai tiến trình cùng đốt CPU 100% trên một lõi trong 12 giây: web **9597 ms**, worker **2401 ms** → đúng **4.00 : 1**. Kèm `IOWeight` cùng tỷ lệ.

- **`MemoryHigh` cho background service** (3× heap, sàn 256 MB) — giới hạn **mềm**: vượt ngưỡng thì kernel throttle và thu hồi bộ nhớ của riêng worker đó, **không giết tiến trình**. Cố ý **không** dùng `MemoryMax` (giới hạn cứng, vượt là OOM-kill): biến một worker chậm thành một worker **chết** thì tệ hơn hẳn vấn đề ban đầu. Web app **không** bị đặt `MemoryHigh` chút nào.

- **Áp được cho unit tạo bằng bản napp cũ.** `CPUWeight`/`IOWeight` được vá vào unit hiện có bằng một phép **phẫu thuật riêng** — không render lại unit, không đụng `ExecStart`/`User`/`Group`. Không có bước này thì directive mới chỉ tới được unit cũ qua `--sync-units`, thứ gần như không ai chạy: lệnh báo thành công, `tune show` in ra tỷ lệ ưu tiên, mà unit thật thì trống không. Ưu tiên CPU/IO **áp ngay bằng `daemon-reload`, không cần restart app** (đã kiểm chứng: `cpu.weight` trong kernel đổi 200 → 350 với **cùng PID**); chỉ heap mới bắt buộc restart vì `NODE_OPTIONS` chỉ được đọc lúc tiến trình khởi động.

- **⚠️ Đừng tin `systemctl show -p CPUWeight`.** Nó chỉ đọc lại giá trị đã **cấu hình** trong unit, kể cả khi cgroup controller `cpu` không bật và dòng đó hoàn toàn vô hiệu — đo được trường hợp `systemctl show` trả `200` trong khi hai tiến trình vẫn chia CPU **1:1**. `napp tune apply` nay đối chiếu với `cpu.weight` **thật trong cgroup** và báo cáo kết quả thật.

- **Trung thực về thứ không chạy.** `IOWeight` chỉ hiệu lực với I/O scheduler `bfq` — VPS NVMe thường dùng `none`/`mq-deadline`, ở đó kernel **không tạo cả file `io.weight`**. `MemoryHigh` chỉ tồn tại ở **cgroup v2** (Ubuntu 22.04+). `napp tune show` dò và nói thẳng máy bạn thuộc nhóm nào thay vì in một con số vô nghĩa; trên cgroup v1 napp **bỏ hẳn** dòng `MemoryHigh` thay vì ghi ra một directive kernel sẽ lờ đi.

- `--service-weight` được **lưu vào registry**, không chỉ là cờ của một lần chạy: không nhớ thì lần `app create` kế tiếp sẽ tính lại theo mặc định và âm thầm lật ngược lựa chọn của người dùng.

- **Sửa lỗi: `app create` tính heap chỉ theo số app web**, bỏ qua background service — nên app đầu tiên trên một máy đã có sẵn worker nhận heap **quá lớn**, và chỉ được sửa lại nếu về sau có app thứ hai kích hoạt cân đối. Nay mẫu số luôn tính cả hai loại.

- `napp check` báo thêm: unit nào còn thiếu `CPUWeight`/`IOWeight`. `--fix` áp được mà **không** cần restart app.

- `CPUWeight`/`IOWeight` nằm trong danh sách `# napp-preserve:` — đặt tay giá trị riêng cho một worker cụ thể thì napp không ghi đè.

## 1.24.0

- **Chặn quét lỗ hổng CMS/framework PHP ngay ở nginx** (`napp nginx scanblock`). Một máy chủ Node công khai nhận hàng nghìn request/ngày dò `/wp-login.php`, `/wp-admin/`, `/phpmyadmin/`, `/cgi-bin/` và các mẫu `eval-stdin.php` của Laravel. Không cái nào **hại** được app Node, nhưng mỗi cái đều đi trọn đường `nginx → proxy_pass → router framework → render 404` — với SSR đó là cả chuỗi hook/layout chạy để dựng trang lỗi cho một con bot — rồi rơi vào access log của site. Nay bị trả **444** ngay tại nginx.

  Tắt toàn máy: `napp nginx unscanblock`. Tắt riêng một site: `napp app set <domain> --no-scan-block`.

- **Đừng kỳ vọng sai vào con số.** `return 444` **không** tiết kiệm nhiều CPU như tên gọi gợi ý: phần đắt nhất của một request quét là bắt tay **TCP + TLS**, mà nginx đã trả xong khoản đó **trước** khi nhìn thấy URI. Thứ tiết kiệm được là vòng qua Node. Khoản lời thật nằm ở chỗ khác — access log sạch, và một tín hiệu ban gần như hoàn hảo cho fail2ban.

- **Log riêng, KHÔNG `access_log off`.** Cách hiển nhiên để hết ồn log là tắt log cho các location bị chặn — và làm vậy là mất luôn jail `nginx-botsearch` (nó đọc `/var/log/nginx/*access.log`): log sạch nhưng scanner không bao giờ bị ban, cứ mở kết nối mãi. Nên request bị chặn ghi sang `/var/log/nginx/napp-scanner.log`. Access log của site sạch bong, còn file đó là tín hiệu hoàn hảo: **mọi dòng** trong nó chắc chắn là scanner.

- **Jail fail2ban `napp-scanner`** đọc đúng file đó, nên ban được rất chặt (3 lần / 10 phút → cấm 1 ngày) mà không có rủi ro ban nhầm. **Đây mới là chỗ tiết kiệm tài nguyên thật**: IP bị ban thì gói tin bị bỏ ở tường lửa, trước cả bắt tay TLS.

- **Sửa lỗi: các jail nginx của fail2ban trước đây không đọc được gì.** `[DEFAULT]` đặt `backend = systemd` — đúng cho `sshd`, nhưng backend đó áp cho **mọi** jail, và với nó fail2ban **bỏ qua `logpath`** để đi đọc journal. Nginx ghi access log ra **file**, không ra journal. Hệ quả: `nginx-botsearch`, `nginx-http-auth`, `nginx-limit-req`, `napp-ratelimit` vẫn `enabled`, `fail2ban-client status` vẫn xanh, mà số IP bị ban đứng yên ở 0 mãi mãi — không có lỗi nào in ra để lần. Các jail nginx nay ghi đè `backend = auto`.

- **Danh sách mẫu cố ý hẹp.** Neo vào **đuôi file** (`.php/.asp/.jsp/.cgi`…) và **namespace riêng** (`/wp-admin/`, `/phpmyadmin/`, `/cgi-bin/`), **không** đoán theo đường dẫn: `/admin`, `/config`, `/vendor`, `/backup`, `/telescope` đều là route hoàn toàn hợp lệ của một app Node. Neo theo đuôi cũng đã bắt luôn phần lớn mẫu Laravel/PHP mà không cần thêm luật. Không có luật cho `.env`/`/.git/` vì vhost đã có sẵn `location ~ /\.(?!well-known).*` — thêm luật thứ hai thì kết quả phụ thuộc vào thứ tự khai báo, mà thứ tự đó khác nhau giữa vhost mới và vhost cũ được vá.

- **Áp được cho app tạo bằng bản napp cũ.** Cơ chế "file location riêng + một dòng `include`" chỉ có từ 1.19.0; vhost tạo trước đó **không có dòng include nào**, nên mọi thứ napp ghi vào `/etc/nginx/napp-locations/` đều không tới được chúng — asset tĩnh, upload, chặn hotlink, chặn quét đều "đã cấu hình" mà **không hề chạy**, trong khi `nginx -t` vẫn xanh và mọi lệnh vẫn báo thành công. `napp nginx sync` và `napp nginx scanblock` nay **tự chèn dòng include còn thiếu**, bằng phép cắt chuỗi theo khối `server` — không render lại vhost, nên **khối SSL của certbot giữ nguyên**.

- **`napp check` báo thêm hai thứ**: vhost nào còn thiếu dòng `include`, và chặn quét lỗ hổng chưa từng được bật. Cả hai đều `--fix` được.

- **`napp nginx sync` hoàn tác theo giao dịch.** Một lệnh nay chạm tới bốn loại file nhân với số app. Hoàn tác nửa vời ở đây không phải "mất cấu hình" mà là nginx **không nạp được** (vhost đã có dòng `include` còn file được include thì vừa bị xoá) — tức là **tắt mọi site trên máy**, không riêng site nào.

- Trạng thái bật/tắt nằm trọn trong nội dung **một file dùng chung** `/etc/nginx/napp-locations/_scanner-block.conf`, không lưu vào `state.json`. Tắt = làm **rỗng** file, **không xoá**: mọi vhost đang include nó.

- ⚠️ **Site sau Cloudflare proxy**: 444 là đóng kết nối không phản hồi, và Cloudflare dịch điều đó thành trang lỗi **520** cho người xem. Ngoài ra, ban bằng `ufw` **vô hiệu** với các site này — fail2ban ban đúng IP thật của client (nhờ real-IP), nhưng gói tin đến từ IP edge của Cloudflare nên luật không bao giờ khớp. Với chúng, hãy chặn ở **WAF của Cloudflare**; phần chặn 444 + tách log ở nginx vẫn hoạt động bình thường.

- ⚠️ `napp nginx sync` nay **render lại file location** `/etc/nginx/napp-locations/<domain>.conf` từ registry (trước đây nó chỉ vá vhost). Nếu bạn từng sửa tay file đó, napp **cảnh báo và sao lưu** (`.napp-orphaned`) trước khi ghi đè — chỗ đúng để đặt location riêng vẫn là file sidecar `<domain>.custom.conf`, thứ napp không bao giờ đụng tới.

- Menu tương tác: thêm **mục 13** (chặn quét) và **mục 14** (gỡ chặn) ở nhóm Hạ tầng — thêm vào **cuối** để không đánh số lại "Xem/Áp tối ưu phần cứng" (11, 12).

## 1.23.0

- **Sửa lỗi: file location tự sinh nuốt mất phần bạn thêm tay, không một lời cảnh báo.** `/etc/nginx/napp-locations/<domain>.conf` được render lại **toàn bộ** từ registry ở **ba** chỗ (`app create`, `app set`, `domain add/remove`) — trong khi nó cũng là chỗ **duy nhất** đặt được location riêng. Ai thêm tay một location (ví dụ `/uploads/`) đều mất nó vào lần chạy kế tiếp của bất kỳ lệnh nào trong ba lệnh đó, và triệu chứng (ảnh vỡ, 404) chỉ hiện ra rất lâu sau, vào lúc chẳng liên quan gì tới lệnh đã gây ra.

- **File sidecar `<domain>.custom.conf`** — napp include nó vào cuối file tự sinh và **không bao giờ** ghi đè. Đây là chỗ đúng để đặt location riêng.

- **Cảnh báo trước khi mất.** Trước khi ghi đè, napp so tập tiền tố `location ^~` cũ với mới: tiền tố nào sắp biến mất thì **sao lưu** file cũ (`.napp-orphaned`) và nói rõ mất cái gì, mất đi đâu. Cố ý so tiền tố chứ không dùng fingerprint như unit systemd — file của app tạo bằng bản napp cũ không có fingerprint nào, dùng cách đó là cảnh báo sai hàng loạt ngay lần nâng cấp đầu tiên, và người dùng học được cách bỏ qua mọi cảnh báo của napp.

- **`--auto-static` nhận diện luôn thư mục file tải lên.** Chỉ nhận ca **an toàn**: thư mục tên `uploads`/`upload` nằm **ngay trong** gốc tĩnh công khai của framework (`static/` của SvelteKit, `public/` của Next/Nuxt/Astro/Vite). Những thư mục đó theo định nghĩa đã công khai, nên phục vụ chúng **không mở thêm gì** — nó chỉ vá đúng khoảng trống: file tải lên *sau* lần build gần nhất không có trong output nên trả 404, rồi tự hiện ra sau lần deploy kế tiếp, trông hệt lỗi chập chờn. Cố ý **không** đoán thư mục ngoài gốc tĩnh (`./uploads`, `./storage`, `./media`): chỗ đó app tự chọn, đoán sai là đem file riêng tư ra đường. Vẫn khai báo tay được bằng `--upload-dir`.

- Tiền tố URL được đặt **kèm theo** thư mục nhận diện được: thư mục tên `upload` (số ít) trước đây bị phục vụ ở `/uploads/` vì đó là mặc định của renderer.

- **Chặn hotlink mạnh hơn hẳn.** `--hotlink-protect` nay phát thêm header `Cross-Origin-Resource-Policy: same-site` cho **mọi** location asset, không chỉ kiểm tra `Referer`. Khác biệt cốt lõi: CORP do **trình duyệt người xem** thực thi dựa trên header do **server bạn** gửi, nên trang hotlink không tác động được — trong khi `Referer` là thứ chính trang đó khai báo, một thẻ `<meta name="referrer" content="no-referrer">` là vô hiệu toàn bộ `valid_referers`. CORP cũng **sống sót qua CDN**: Cloudflare cache theo URL rồi trả cho mọi referer mà không hỏi origin, còn CORP nằm trong chính response đã cache. Và nó **không** phá thứ mà chặn Referer gắt phá: bot lấy ảnh preview (Facebook, Zalo, Telegram) tải ảnh ở phía **server** nên không bị áp — link chia sẻ vẫn có ảnh. Dùng `same-site` chứ không `same-origin` vì napp tự thêm alias `www.<domain>` và admin/api thường ở subdomain khác.

- **CORP không được phát khi có `--hotlink-allow`**: CORP chỉ có ba giá trị, không diễn đạt được danh sách cho phép theo domain — phát ra là chặn đúng những đối tác vừa cho phép, và ảnh vỡ ở phía họ mà không ai báo. napp nói rõ khi rơi vào trường hợp này, kèm hướng đi thật (URL ký `secure_link`, hoặc tầng CDN).

- **`--hotlink-strict`** (mới): bỏ `none`/`blocked` khỏi `valid_referers`. Chặt hơn nhưng **mất ảnh preview** khi chia sẻ link và 403 nhầm người dùng sau proxy công ty — napp cảnh báo mỗi lần cờ này bật.

- `napp check` báo thêm: app nào có thư mục tải lên trong gốc tĩnh công khai mà nginx chưa phục vụ. `--fix` sửa được.

## 1.22.0

- **`--auto-static`: napp nhận diện framework từ thư mục build** rồi cho nginx trả thẳng asset, thay vì bắt bạn tự tra tiền tố. Nhận SvelteKit adapter-node (`build/client/_app` → `/_app/`), Next.js (`.next/static` → `/_next/static/`), Nuxt 3/Nitro (`.output/public/_nuxt` → `/_nuxt/`), SolidStart/Vinxi (`.output/public/_build` → `/_build/`), Astro (`dist/client/_astro` hoặc `dist/_astro` → `/_astro/`). Dùng được ở cả `app create` lẫn `app set`.

  Căn cứ là **thư mục có thật**, không phải dependencies: `package.json` ở gốc monorepo không nói được app con dùng adapter nào, và cùng một app SvelteKit thì adapter-node sinh `build/client` còn adapter-static sinh `build` với deps y hệt. Hệ quả: chỉ nhận diện được **sau khi build** — chưa build thì báo không nhận ra, không đoán bừa.

- **`--static-alias <tiền-tố>=<thư-mục>`**: phục vụ bằng `alias` thay vì `root`. Cần cho Next.js — file ở `.next/static/…` nhưng URL là `/_next/static/…`, nên `root .next` đi tìm `.next/_next/static/…` và **toàn bộ** JS/CSS trả 404 (trang trắng). Với Next.js, napp **chỉ** chiếm `/_next/static/`: `/_next/image` và `/_next/data` phải đi qua Node.

- **`/assets/` chỉ được gợi ý, không bao giờ tự áp** — kể cả với `--auto-static`. `/_app/`, `/_next/`, `/_nuxt/`, `/_astro/` là namespace riêng của framework nên chiếm được an toàn; `/assets/` (Remix · React Router v7 · Vite SPA) thì app hoàn toàn có thể dùng làm route thật, mà `location ^~` thắng cả route regex lẫn `proxy_pass` — áp nhầm là route đó **chết hẳn bằng 404**, không log, không lỗi.

- **Sửa lỗi: asset tĩnh trả 403 chứ không phải file.** Thư mục app thuộc user riêng và để `750`, worker nginx chạy bằng user khác (`www-data`) nên không đi xuyên qua nổi `/var/www/<domain>` — nghĩa là **mọi** cấu hình `--static-root`/`--upload-dir` từ trước tới nay đều 403 trên máy sạch, và log nginx ghi `Permission denied`, rất dễ đọc nhầm thành sai đường dẫn. napp nay tự thêm `www-data` vào **nhóm** của app rồi **restart** nginx (reload không đủ: danh sách nhóm chỉ đọc lúc tiến trình khởi tạo). `.env` vẫn an toàn vì để `600`.

- `napp check` báo thêm hai thứ cho app **đang chạy**: app nào còn đẩy toàn bộ asset qua Node dù nhận diện được framework (loại hỏng không có triệu chứng nào ngoài "vào dashboard thấy giựt"), và app nào có cấu hình tĩnh mà nginx không đọc được. `--fix` sửa được cả hai (trừ nhóm `/assets/` rủi ro).

- Menu tương tác: thêm mục "Bật nginx trả asset tĩnh", và bước tạo app có hỏi luôn. **Cố ý hỏi** chứ không bật ngầm — napp đang chiếm một tiền tố URL.

## 1.21.0

- **Sửa tay unit systemd không còn bị ghi đè.** Trước đây mọi đường dẫn đụng tới unit đều render lại **toàn bộ** file từ template rồi ghi đè. Ai sửa `ExecStart` (thêm cờ runtime, đổi entrypoint), `StandardOutput`/`StandardError` (đẩy log sang journal), hay `User`/`Group` sẽ mất sạch sau lần `napp tune apply` — hoặc thậm chí chỉ vì tạo thêm một app, vì đó cũng là lúc heap phải chia lại. App chết ngay lúc restart, đúng lúc không ai ngờ tới.

  napp nay nhận ra phần bạn đã sửa và giữ nguyên. Mỗi unit mang một dòng `# napp-fingerprint:` (băm của phần còn lại trong file): khớp = còn nguyên bản napp, lệch hoặc không có = đã có người sửa. Khi phát hiện file đã sửa, napp so từng directive và ghi tên cái bạn đổi vào dòng `# napp-preserve:` — dòng này để **lần ghi sau vẫn nhớ**, nếu chỉ dựa vào fingerprint thì ngay sau lần giữ đầu tiên file lại "khớp" và lần thứ hai sẽ ghi đè mất. Bạn cũng có thể tự thêm `# napp-preserve: Tên1 Tên2` để khoá trước một directive.

  Directive được giữ: `ExecStart*`, `ExecStop*`, `ExecReload`, `Standard*`, `SyslogIdentifier`, `User`, `Group`, `UMask`, `WorkingDirectory`, `Restart*`, `Timeout*Sec`, `LimitNOFILE`, `Nice`, `OOMScoreAdjust`, `MemoryMax`, `MemoryHigh`, `CPUQuota`. Phần **hardening** (`ProtectSystem`, `NoNewPrivileges`, `ReadWritePaths`…) cố ý **không** nằm trong danh sách, để bản vá bảo mật còn đường lan tới unit cũ.

- **Cân đối heap V8 chỉ sửa đúng một dòng.** `napp tune apply` và mọi lần tạo/xoá app (heap chia theo tổng số đơn vị node nên số app đổi là phải tính lại) nay chỉ thay con số trong `--max-old-space-size` của dòng `Environment=NODE_OPTIONS` — giữ nguyên từng ký tự của mọi dòng khác, kể cả các cờ NODE_OPTIONS khác trên chính dòng đó. Đây là đường chạy ngầm và chạy thường xuyên nhất; render lại cả file cho **một con số** là cách chắc chắn nhất để một ngày nào đó thổi bay cấu hình sửa tay.

  Kèm theo: **chỉ restart unit thực sự đổi số**. Trước đây mọi unit đều bị ghi lại nên restart hết là hợp lý; nay app bun (JavaScriptCore, không hiểu cờ heap của V8) và app đã đúng số không có gì thay đổi — restart chúng chỉ là một khoảng downtime không đổi lại được gì.

- **`napp tune apply --sync-units`** (mới, mặc định tắt): render lại toàn bộ unit từ template để đẩy phần mới (hardening, `ReadWritePaths`, thứ tự biến môi trường) xuống unit tạo từ bản napp cũ. Đây là việc **cũ vẫn làm ngầm**, nay phải gõ ra — nó đổi nhiều dòng, và unit là nơi người dùng hay sửa tay nhất. Kể cả ở chế độ này, directive bạn sửa vẫn được giữ.

- **Directive chính bạn vừa ra lệnh đổi thì napp vẫn làm chủ.** `napp service set --run-as` đổi `User`/`Group`; giữ bản sửa tay ở đây là làm ngược lại thứ bạn vừa gõ. napp ghi đè và **báo rõ** directive nào vừa bị đặt lại, thay vì im lặng. Tương tự với `ExecStart` của unit backup/Cloudflare sync (nó mang chính các tuỳ chọn `--target`/`--keep-days`/`--time` bạn truyền vào).

- Unit backup và Cloudflare sync cũng đi qua cùng cơ chế này — sửa `Nice`, log hay `User`/`Group` của chúng nay cũng còn nguyên.

## 1.20.1

- **`napp --help` có phần ví dụ ở cuối**, gồm mục **"sau khi cập nhật napp"** — danh sách lệnh do commander tự sinh trả lời được "có những lệnh gì" nhưng không nhắc các bước **bắt buộc** sau khi nâng cấp, mà bỏ qua chúng thì server vẫn mang cấu hình cũ đã hỏng (`volatile-lru` làm mất job BullMQ, bộ đệm `16k` làm route SvelteKit sâu trả 502). Chỉ ghi vào changelog là chưa đủ — gần như không ai đọc changelog.

- **Menu tương tác có mục "Đồng bộ cấu hình proxy nginx vào vhost đã có"** (mục 10 của nhóm Hạ tầng). Trước đó `napp nginx sync` **không hề xuất hiện trong menu**, tức là người chỉ dùng menu không có đường nào chạm tới bước sửa 502. ⚠️ Việc chèn này đẩy **"Xem đề xuất tối ưu phần cứng" xuống 11** và **"Áp tối ưu phần cứng" xuống 12**.

- Mô tả lệnh đã cập nhật cho khớp thực tế: `nginx` (cấu hình proxy dùng chung + hardening), `nginx sync` (nói rõ là gỡ bộ đệm cũ, giữ SSL), `check` (nêu cả việc phát hiện cấu hình Redis/nginx lỗi thời), `service create` (nhắc `--run-as`).

## 1.20.0

- **Sửa: route SvelteKit lồng sâu trả 502 vì bộ đệm proxy quá nhỏ.** `proxy_buffer_size` là bộ đệm chứa **toàn bộ khối header** của response; vượt quá là nginx cắt kết nối, trả 502 và ghi `upstream sent too big header while reading response header from upstream`. App phía sau vẫn khoẻ (curl thẳng vào `127.0.0.1:<port>` ra đúng), nên lỗi này rất dễ bị đổ cho Node.

  SvelteKit đụng trần ở **route sâu**: mỗi tầng layout/page góp thêm mục `Link: </_app/immutable/…>; rel=modulepreload` vào header, tên file lại có hash dài — cùng một app, trang chủ chạy tốt còn `/admin/hotels/1/rooms/2/edit` thì 502. Thêm `Set-Cookie` phiên đăng nhập nữa là chạm 16k dễ như không. Giá trị mới (đã kiểm chứng trên máy thật):

  ```nginx
  proxy_buffering on;
  proxy_buffer_size 128k;   # trước: 16k
  proxy_buffers 4 256k;     # trước: 16 16k
  proxy_busy_buffers_size 256k;
  ```

- **Bộ đệm chuyển lên mức `http`, đặt MỘT CHỖ trong `/etc/nginx/conf.d/00-napp-proxy.conf`.** Trước đây mỗi vhost mang một bản sao trong `location /`, nghĩa là mỗi lần đổi giá trị phải sửa lại vhost — mà vhost chính là chỗ certbot chèn khối SSL vào, render lại là mất HTTPS của site đang chạy. Nay vhost mới không còn khối bộ đệm, chỉ kế thừa từ file dùng chung.

- **`napp nginx sync` gỡ khối bộ đệm nội tuyến khỏi vhost cũ.** Bắt buộc, vì giá trị trong `location` **luôn thắng** giá trị mức `http`: không gỡ thì site tạo bằng bản cũ vẫn giữ `16k` và vẫn 502. Việc gỡ cắt theo **dòng** (không phải regex nuốt cả khối) và không render lại vhost — đã kiểm chứng trên vhost certbot đã sửa: 4/4 dòng `managed by Certbot` còn nguyên, `ssl_certificate` còn nguyên, chú thích của directive khác không bị đụng, chạy lại lần hai không đổi gì thêm. Vẫn có sao lưu + hoàn tác nếu `nginx -t` trượt.

  ```bash
  sudo napp nginx sync    # site đã tạo bằng bản cũ PHẢI chạy lệnh này
  ```

- Bộ đệm chỉ được cấp khi có request đang chạy (không cấp phát trước), nên chi phí bộ nhớ đi theo tải thực tế chứ không theo số vhost. Cần giá trị riêng cho một site thì thêm `proxy_buffer_size`/`proxy_buffers` vào `location /` của vhost đó.

## 1.19.0

- **`napp service create --run-as <domain|name>` — worker chạy bằng user của app web đã có.** Trước đây mọi background service đều có user riêng `nas_<name>`, đúng cho worker độc lập (bot, cron poller) nhưng **không dùng được** cho worker đụng vào FILE của một app web — nén ảnh trong thư mục upload, sinh thumbnail, dọn cache. Thư mục app là `750`/file `640` của user app, user khác **đọc còn không nổi**; mà nới quyền thư mục ra cho hai user là mở luôn cho mọi thứ khác trên máy.

  `--run-as` gỡ **cả hai** lớp chặn — thiếu một lớp là hỏng, và mỗi lớp hỏng một kiểu:

  | Lớp | Triệu chứng khi thiếu | `--run-as` làm gì |
  |---|---|---|
  | Quyền Unix | `EACCES` | `User=`/`Group=` của unit là user app |
  | Sandbox systemd (`ProtectSystem=strict`) | `EROFS` dù `ls -l` trông đúng quyền | thêm thư mục app vào `ReadWritePaths=` |

  Mặc định **không đổi**: không truyền `--run-as` thì service vẫn có user riêng, cô lập hoàn toàn như trước.

- **`--write-dir <path>` (lặp lại được)** — cấp quyền ghi vào đường dẫn ngoài mã nguồn service (kho ảnh dùng chung, thư mục media gắn ngoài). Đường dẫn phải tồn tại sẵn: systemd **từ chối khởi động** unit khi `ReadWritePaths` trỏ vào chỗ không có, và lỗi lúc đó (`Failed to set up mount namespacing`) không nhắc đường dẫn nào sai — nên napp kiểm tra và báo ngay lúc tạo.

- **`napp service set <name>` — đổi danh tính/quyền ghi của service ĐÃ TẠO.** `--run-as <domain|name>` để mượn user, `--standalone` để quay về user riêng, `--write-dir` để đặt lại danh sách ghi thêm. Nhu cầu "worker cần đụng file của app web" gần như luôn lộ ra **sau** khi worker đã chạy, và trước bản này cách duy nhất là xoá đi tạo lại (mất `.env`, dễ lỡ tay mất cả database). Lệnh này `chown` lại mã nguồn sang user mới, ghi lại unit, restart.

- **napp KHÔNG BAO GIỜ xoá user đi mượn.** `napp service remove --source` của một service `--run-as` giữ nguyên user (user thuộc về app web). Ở chiều ngược lại, `napp app remove --source` **từ chối** xoá user khi còn worker đang mượn, kèm danh sách worker phải gỡ trước — xoá user đi thì worker chết ngay lần khởi động sau với lỗi (`Failed to determine user credentials`) không hề nhắc tới app vừa gỡ.

- **Đánh đổi phải biết:** dùng chung user là dùng chung **danh tính Unix**. Worker đọc/ghi được mọi thứ của app web kể cả `.env` (mật khẩu DB, khoá API), và ngược lại; một bên bị chiếm quyền là bên kia mất theo. napp cảnh báo rõ điều này ngay lúc tạo. Chỉ dùng khi hai bên là hai nửa của **cùng một sản phẩm**.

- Menu tương tác hỏi thêm "worker này có đọc/ghi file của một app web không" và tự đề xuất dùng chung Redis DB với app đó. `napp service list` hiện cột `run-as=`.

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

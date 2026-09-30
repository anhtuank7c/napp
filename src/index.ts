import { Command, Option } from "commander";
import { setDryRun, state as execState } from "./lib/exec";
import { printDie, NappError } from "./lib/log";
import { NAPP_VERSION } from "./version";

import { cmdCheck } from "./commands/check";
import { cmdDoctor, cmdDoctorSystem, cmdDoctorDeps, cmdDoctorUpgrade } from "./commands/doctor";
import {
  cmdAppCreate,
  cmdAppDeploy,
  cmdAppRemove,
  cmdAppList,
  cmdAppRestart,
  cmdAppStop,
  cmdAppStart,
  cmdAppLogs,
  cmdAppEnvSet,
  cmdAppSet,
} from "./commands/app";
import {
  cmdServiceCreate,
  cmdServiceDeploy,
  cmdServiceRemove,
  cmdServiceList,
  cmdServiceRestart,
  cmdServiceStop,
  cmdServiceStart,
  cmdServiceLogs,
  cmdServiceEnvSet,
  cmdServiceSet,
} from "./commands/service";
import { cmdDomainAdd, cmdDomainRemove, cmdDomainList } from "./commands/domain";
import { cmdCertIssue, cmdCertRenew, cmdCertRevoke, cmdCertList, cmdCertStatus } from "./commands/cert";
import { cmdDbCreate, cmdDbDrop, cmdDbList, cmdDbBackup } from "./commands/db";
import { cmdDbEngineList, cmdDbEngineAdd, cmdDbEngineRemove, cmdDbEngineDefault, cmdDbEngineSelect } from "./commands/dbengine";
import { cmdRedisInfo, cmdRedisAllocations, cmdRedisFlush } from "./commands/redis";
import { cmdBackupRun, cmdBackupList, cmdBackupSchedule, cmdBackupUnschedule, DEFAULT_RETENTION_DAYS, type BackupTarget } from "./commands/backup";
import { cmdFirewallSync, cmdFirewallStatus } from "./commands/firewall";
import { cmdFail2banSetup, cmdFail2banStatus, cmdFail2banUnban } from "./commands/fail2ban";
import { cmdTuneShow, cmdTuneApply } from "./commands/tune";
import { cmdMemStatus, cmdMemTrend, cmdMemSample, cmdMemWatch, cmdMemUnwatch, cmdMemSnapshot, cmdMemGuard } from "./commands/mem";
import { SERVICE_WEIGHT_DEFAULT } from "./templates/tuning";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule } from "./commands/cloudflare";
import { cmdNginxHarden, cmdNginxUnharden, cmdNginxSync, cmdNginxScanBlock, cmdNginxUnscanBlock } from "./commands/nginx";
import { cmdUpdate, cmdVersion, cmdChangelog } from "./commands/update";
import { cmdInstallSelf, cmdUninstallSelf } from "./commands/installSelf";
import { runMenu } from "./commands/menu";

const program = new Command();

program
  .name("napp")
  .description("napp — quản lý server lưu trữ nhiều ứng dụng Node.js/Bun (domain, SSL, systemd, database MariaDB/MySQL/PostgreSQL/MongoDB, Redis, nginx, fail2ban, UFW, Cloudflare, backup, tối ưu phần cứng, OTA update)")
  .version(NAPP_VERSION, "-V, --version")
  .option("--dry-run", "chỉ in ra các bước sẽ thực hiện, không thay đổi gì thật")
  .option("--verbose", "in chi tiết các lệnh hệ thống được thực thi")
  .hook("preAction", (thisCmd) => {
    const opts = thisCmd.opts();
    setDryRun(Boolean(opts.dryRun));
    execState.verbose = Boolean(opts.verbose);
  });

// Danh sách lệnh do commander tự sinh trả lời "có những lệnh gì", nhưng không
// trả lời "gõ gì trước" và nhất là không nhắc các bước BẮT BUỘC sau khi nâng
// cấp napp — những bước mà bỏ qua thì server vẫn mang cấu hình cũ đã hỏng
// (Redis volatile-lru làm mất job BullMQ, bộ đệm 16k làm route SvelteKit sâu
// trả 502). Chỉ changelog nhắc là chưa đủ: gần như không ai đọc changelog.
program.addHelpText(
  "after",
  `
Bắt đầu nhanh:
  sudo napp                      mở menu tương tác (gõ số, 0 để quay lại)
  sudo napp check --fix          kiểm tra + tự cài thành phần còn thiếu
                                 (database mặc định MariaDB; chọn khác: --db postgresql
                                  | mysql | mongodb | none, nhiều engine: --db mariadb,mongodb)
  sudo napp app create <domain> --repo <url> --db --redis
  sudo napp cert issue <domain> --email <email>
  sudo napp tune apply           tối ưu theo phần cứng (chạy lại khi nâng cấp server)

Sau khi cập nhật napp (bản cũ để lại cấu hình đã hỏng, không tự sửa):
  sudo napp nginx sync           gỡ bộ đệm proxy 16k nội tuyến khỏi vhost cũ
                                 -> hết 502 'upstream sent too big header' ở
                                    route SvelteKit lồng sâu.
                                 Đồng thời chèn dòng 'include' file location vào
                                 vhost tạo bằng bản napp cũ, và BẬT chặn quét lỗ
                                 hổng (.php/wp-admin/phpmyadmin -> 444, log riêng)
  sudo napp fail2ban setup       bật jail 'napp-scanner' — ban IP quét ngay ở
                                 tường lửa. Đây mới là chỗ tiết kiệm tài nguyên
                                 thật: 444 vẫn phải trả tiền bắt tay TLS.
                                 Cũng sửa 'backend' của các jail nginx: bản cũ
                                 để backend=systemd nên chúng KHÔNG đọc được
                                 access log (file), tức chưa từng ban được ai
  sudo napp tune apply           cân đối lại heap V8 THEO TRỌNG SỐ (web app gấp
                                 đôi background service) và vá CPUWeight/
                                 IOWeight/MemoryHigh vào unit tạo từ bản cũ —
                                 unit cũ không có dòng nào trong số đó, nên
                                 worker nén ảnh vẫn tranh CPU NGANG CƠ với web
                                 app. LƯU Ý: heap đổi thì app phải restart.
                                 Thêm --skip-restart để áp ngay phần ưu tiên
                                 CPU (daemon-reload là đủ) và hoãn phần heap
  sudo napp check                báo Redis còn maxmemory-policy khác noeviction
                                 (BullMQ mất job), vhost nào còn bộ đệm cũ, VÀ
                                 app nào còn đẩy toàn bộ asset tĩnh qua Node
                                 (chậm mà không có lỗi nào để lần ra)
  sudo napp app set <domain> --auto-static
                                 nhận diện framework từ thư mục build rồi cho
                                 nginx trả thẳng asset. Tự cấp luôn quyền đọc
                                 cho nginx — thiếu bước đó thì asset trả 403
  sudo napp tune apply --sync-units
                                 CHỈ khi cần đẩy hardening/template mới xuống
                                 unit tạo từ bản napp cũ. Không có cờ này,
                                 tune apply chỉ sửa đúng các dòng cần sửa
                                 (--max-old-space-size, CPUWeight, IOWeight,
                                 MemoryHigh) và không đụng ExecStart/Standard*/
                                 User/Group bạn sửa tay

Nghi ngờ rò rỉ bộ nhớ (app tự chết rồi tự sống lại mà không ai hay):
  sudo napp mem status           bộ nhớ hiện tại + SỐ LẦN systemd đã âm thầm
                                 khởi động lại. Unit napp đều 'Restart=always'
                                 nên app rò rỉ chết rồi tự dậy, lặp nhiều ngày
  sudo napp mem watch            lấy mẫu định kỳ -> 'napp mem trend' kết luận
                                 được xu hướng (cần ít nhất 6 giờ dữ liệu)
  sudo napp mem guard <app>      bật cờ Node tự chụp heap TRƯỚC khi chết vì OOM
  sudo napp mem snapshot <app>   chụp heap ngay, app vẫn chạy -> mở bằng
                                 Chrome DevTools > Memory để tìm thủ phạm

Worker của một app web (hai nửa của cùng một sản phẩm):
  sudo napp service create <name> --run-as <domain> --share-redis-with <domain>
       --run-as         chạy bằng user của app -> đọc/ghi được file của app
       --share-redis-with  chung keyspace -> hàng đợi mới chạy
  sudo napp service set <name> --run-as <domain>    (đổi cho service ĐÃ TẠO)

Chi tiết từng lệnh: napp <lệnh> --help · lịch sử thay đổi: napp changelog
`
);

// ---------------------------------------------------------------- check ---
program
  .command("check")
  .description("kiểm tra môi trường máy chủ (Node.js, nginx, certbot, database, Redis, fail2ban, UFW) + phát hiện cấu hình Redis/nginx đã lỗi thời")
  .option("--fix", "tự cài đặt/khởi động các thành phần còn thiếu (cần sudo)")
  .option("-y, --yes", "không hỏi xác nhận khi dùng --fix")
  .option("--db <engines>", "chọn database engine: mariadb (mặc định), mysql, postgresql, mongodb, hoặc 'none'; nhiều engine cách nhau dấu phẩy")
  .action(async (opts) => cmdCheck({ fix: Boolean(opts.fix), yes: Boolean(opts.yes), db: opts.db }));

// ----------------------------------------------------------------- doctor ---
// Khác 'check' (môi trường ĐỦ chưa) — 'doctor' hỏi môi trường AN TOÀN chưa:
// bản vá đang chờ, dịch vụ còn chạy thư viện cũ, CVE nổi bật, và rủi ro chuỗi
// cung ứng trong dependencies của từng app/service.
const doctor = program
  .command("doctor")
  .description("soi rủi ro bảo mật: bản vá hệ thống đang chờ + rủi ro chuỗi cung ứng của dependencies")
  .option("--no-refresh", "không chạy 'apt-get update' trước khi kiểm tra")
  .option("--no-audit", "bỏ qua audit lỗ hổng của package manager (không cần mạng)")
  .option("--deep", "tra thêm tuổi bản phát hành của dependency trực tiếp trên registry npm (cần mạng)")
  .action(async (opts) => cmdDoctor({ refresh: opts.refresh !== false, audit: opts.audit !== false, deep: Boolean(opts.deep) }));

doctor
  .command("system")
  .description("kiểm tra bản vá bảo mật đang chờ, dịch vụ còn nạp thư viện cũ, CVE nginx, vòng đời Node.js")
  .option("--no-refresh", "không chạy 'apt-get update' trước khi kiểm tra")
  .action(async (opts) => {
    cmdDoctorSystem({ refresh: opts.refresh !== false });
  });

doctor
  .command("deps [target]")
  .description("quét rủi ro chuỗi cung ứng trong dependencies (bỏ trống target = quét mọi app + service)")
  .option("--no-audit", "bỏ qua audit lỗ hổng của package manager (không cần mạng)")
  .option("--deep", "tra thêm tuổi bản phát hành của dependency trực tiếp trên registry npm (cần mạng)")
  .action(async (target, opts) => {
    await cmdDoctorDeps({ target, audit: opts.audit !== false, deep: Boolean(opts.deep) });
  });

doctor
  .command("upgrade")
  .description("cài bản vá (mặc định CHỈ bản vá bảo mật) rồi khởi động lại dịch vụ để bản vá có hiệu lực")
  .option("--all", "cài mọi bản cập nhật đang chờ, không chỉ bản vá bảo mật")
  .option("--only <pkg...>", "chỉ nâng cấp các gói này (vd: --only nginx)")
  .option("--no-restart", "không tự khởi động lại dịch vụ sau khi cài (chỉ in hướng dẫn)")
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (opts) =>
    cmdDoctorUpgrade({
      all: Boolean(opts.all),
      only: opts.only ?? [],
      yes: Boolean(opts.yes),
      restart: opts.restart !== false,
    })
  );

// ------------------------------------------------------------------ app ---
const app = program.command("app").description("quản lý các ứng dụng Node.js/Bun");

app
  .command("create <domain>")
  .description("tạo app mới: user hệ thống riêng, clone repo, systemd service, nginx vhost")
  .option("--port <port>", "cổng nội bộ (mặc định: tự cấp phát 3000-3999)", (v) => parseInt(v, 10))
  .option("--repo <url>", "git repo để clone (bỏ trống để tạo app mẫu rỗng)")
  .option("--branch <branch>", "branch git", "main")
  .option("--token <token>", "Personal Access Token để clone repo PRIVATE qua HTTPS (không hỏi mật khẩu)")
  .option("--ssh-key <path>", "deploy key để clone repo PRIVATE qua SSH — đường dẫn file HOẶC nội dung key")
  .addOption(new Option("--runtime <runtime>", "runtime chạy app").choices(["node", "bun"]).default("node"))
  .addOption(new Option("--package-manager <pm>", "trình quản lý gói phụ thuộc (mặc định: bun nếu runtime bun, còn lại npm)").choices(["npm", "pnpm", "yarn", "bun"]))
  .option("--install-cmd <cmd>", "lệnh cài dependencies (mặc định theo package manager)")
  .option("--build-cmd <cmd>", "lệnh build (vd: 'npm run build')")
  .option("--start-cmd <cmd>", "lệnh khởi động (mặc định theo runtime, vd: 'npm start')")
  .option(
    "--address-header",
    "đặt ADDRESS_HEADER/XFF_DEPTH cho SvelteKit adapter-node — CHỈ dùng khi app KHÔNG tự phân giải IP khách (xem README)"
  )
  .option("--db [engine]", "tạo kèm database riêng cho app (engine: mariadb | mysql | postgresql | mongodb; bỏ trống = engine mặc định/duy nhất đang cài)")
  .option("--redis", "cấp Redis DB riêng cho app (0-15)")
  .option("--redis-db <n>", "dùng Redis DB CHỈ ĐỊNH (cho phép dùng CHUNG với đơn vị khác)", (v) => parseInt(v, 10))
  .option("--share-redis-with <domain|name>", "dùng CHUNG Redis DB với app/service đã có (bắt buộc cho cặp web + worker)")
  .option("--app-dir <path>", "monorepo: thư mục con chứa app, tương đối so với mã nguồn (vd 'apps/backend')")
  .option("--max-body <size>", "client_max_body_size của nginx (mặc định 20M; tăng nếu app cho upload file lớn)")
  .option("--static-root <dir>", "thư mục asset build để NGINX trả thẳng thay vì qua Node (vd '<webRoot>/build/client')")
  .option("--upload-dir <dir>", "thư mục file NGƯỜI DÙNG TẢI LÊN lúc chạy — KHÁC --static-root, xem README (vd '<webRoot>/static/uploads')")
  .option("--upload-prefix <path>", "tiền tố URL của --upload-dir (mặc định '/uploads/')")
  .option("--hotlink-protect", "chỉ cho nhúng asset/ảnh từ domain của site (CORP do trình duyệt thực thi + kiểm tra Referer)")
  .option("--hotlink-strict", "chặt hơn: BỎ 'none'/'blocked' khỏi valid_referers — đổi lại MẤT ảnh preview khi chia sẻ link")
  .option(
    "--hotlink-allow <domain...>",
    "domain NGOÀI cũng được phép nhúng, lặp lại được (vd 'partner.com' hoặc '*.cdn.net')",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--static-prefix <path...>",
    "tiền tố URL phục vụ từ --static-root, lặp lại được (SvelteKit: /_app/ · Nuxt: /_nuxt/ · Astro: /_astro/). Next.js dùng --static-alias",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--static-alias <prefix=dir...>",
    "tiền tố URL phục vụ bằng 'alias', lặp lại được — dùng khi URL khác tên thư mục (Next.js: '/_next/static/=<webRoot>/.next/static')",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--auto-static", "tự nhận diện framework từ thư mục build và cho nginx trả thẳng asset (SvelteKit, Next.js, Nuxt, SolidStart, Astro)")
  .option("--env <KEY=VALUE...>", "biến môi trường bổ sung, có thể lặp lại nhiều lần", (v, prev: string[]) => [...prev, v], [] as string[])
  .action(async (domain, opts) => {
    await cmdAppCreate(domain, {
      port: opts.port,
      repo: opts.repo,
      branch: opts.branch,
      token: opts.token,
      sshKey: opts.sshKey,
      runtime: opts.runtime,
      packageManager: opts.packageManager,
      installCmd: opts.installCmd,
      buildCmd: opts.buildCmd,
      startCmd: opts.startCmd,
      db: Boolean(opts.db),
      dbEngine: typeof opts.db === "string" ? opts.db : undefined,
      redis: Boolean(opts.redis),
      redisDb: opts.redisDb,
      shareRedisWith: opts.shareRedisWith,
      appDir: opts.appDir,
      addressHeader: Boolean(opts.addressHeader),
      maxBody: opts.maxBody,
      staticRoot: opts.staticRoot,
      staticPrefix: (opts.staticPrefix ?? []).length > 0 ? opts.staticPrefix : undefined,
      staticAlias: (opts.staticAlias ?? []).length > 0 ? opts.staticAlias : undefined,
      autoStatic: Boolean(opts.autoStatic),
      uploadDir: opts.uploadDir,
      uploadPrefix: opts.uploadPrefix,
      hotlinkProtect: Boolean(opts.hotlinkProtect),
      hotlinkStrict: Boolean(opts.hotlinkStrict),
      hotlinkAllow: (opts.hotlinkAllow ?? []).length > 0 ? opts.hotlinkAllow : undefined,
      env: opts.env ?? [],
    });
  });

app
  .command("deploy <domain>")
  .description("git pull + cài dependencies + build + restart service")
  .action(async (domain) => cmdAppDeploy(domain));

app
  .command("remove <domain>")
  .description("gỡ app khỏi napp — chọn xoá nginx / ssl / mã nguồn / database (service systemd luôn bị gỡ)")
  .option("-y, --yes", "không hỏi xác nhận (mặc định: xoá nginx + ssl, GIỮ mã nguồn + database)")
  .option("--all", "xoá tất cả: nginx, ssl, mã nguồn (+ user), database")
  .option("--source", "xoá luôn mã nguồn và user hệ thống của app")
  .option("--db", "xoá luôn database")
  .option("--keep-nginx", "giữ lại cấu hình nginx")
  .option("--keep-ssl", "giữ lại chứng chỉ SSL")
  .option("--keep-db", "giữ lại database (mặc định đã giữ; cờ này để tương thích script cũ)")
  .action(async (domain, opts) =>
    cmdAppRemove(domain, {
      yes: Boolean(opts.yes),
      nginx: opts.all ? true : !opts.keepNginx,
      ssl: opts.all ? true : !opts.keepSsl,
      source: Boolean(opts.all || opts.source),
      database: opts.all ? true : Boolean(opts.db) && !opts.keepDb,
    })
  );

app.command("list").description("liệt kê các app đang quản lý").action(() => cmdAppList());
app.command("restart <domain>").description("khởi động lại app").action((domain) => cmdAppRestart(domain));
app.command("stop <domain>").description("dừng app").action((domain) => cmdAppStop(domain));
app.command("start <domain>").description("khởi động app").action((domain) => cmdAppStart(domain));

app
  .command("logs <domain>")
  .description("xem log của app (qua journalctl)")
  .option("-f, --follow", "theo dõi log liên tục")
  .option("-n, --lines <n>", "số dòng log", (v) => parseInt(v, 10), 100)
  .action((domain, opts) => cmdAppLogs(domain, { follow: Boolean(opts.follow), lines: opts.lines }));

app
  .command("set <domain>")
  .description("đổi cấu hình NGINX của app ĐÃ TẠO (asset tĩnh, file tải lên, chặn hotlink, giới hạn upload) — xem --auto-static")
  .option("--static-root <dir>", "thư mục asset build để NGINX trả thẳng thay vì qua Node")
  .option(
    "--static-prefix <path...>",
    "tiền tố URL phục vụ từ --static-root, lặp lại được (SvelteKit: /_app/ · Nuxt: /_nuxt/ · Astro: /_astro/). Next.js dùng --static-alias",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--static-alias <prefix=dir...>",
    "tiền tố URL phục vụ bằng 'alias', lặp lại được — dùng khi URL khác tên thư mục (Next.js: '/_next/static/=<webRoot>/.next/static')",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--auto-static", "nhận diện framework từ thư mục build rồi áp cấu hình tĩnh phù hợp (SvelteKit, Next.js, Nuxt, SolidStart, Astro)")
  .option("--upload-dir <dir>", "thư mục file NGƯỜI DÙNG TẢI LÊN lúc chạy (khác --static-root)")
  .option("--upload-prefix <path>", "tiền tố URL của --upload-dir (mặc định '/uploads/')")
  .option("--hotlink-protect", "chỉ cho nhúng asset/ảnh từ domain của site (CORP + kiểm tra Referer)")
  .option("--no-hotlink-protect", "tắt chặn hotlink")
  .option("--hotlink-strict", "chặt hơn: BỎ 'none'/'blocked' khỏi valid_referers — đổi lại MẤT ảnh preview khi chia sẻ link")
  .option("--no-hotlink-strict", "quay lại mức mặc định (cho phép 'none'/'blocked')")
  .option(
    "--hotlink-allow <domain...>",
    "domain NGOÀI cũng được phép nhúng, lặp lại được",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--max-body <size>", "client_max_body_size của nginx (vd '100M')")
  .option("--scan-block", "bật lại chặn quét lỗ hổng cho site này (mặc định đã bật)")
  .option("--no-scan-block", "TẮT chặn quét lỗ hổng cho RIÊNG site này — chỉ cần khi site thật sự phục vụ .php qua upstream khác")
  .action((domain, opts) =>
    cmdAppSet(domain, {
      staticRoot: opts.staticRoot,
      staticPrefix: (opts.staticPrefix ?? []).length > 0 ? opts.staticPrefix : undefined,
      staticAlias: (opts.staticAlias ?? []).length > 0 ? opts.staticAlias : undefined,
      autoStatic: Boolean(opts.autoStatic),
      uploadDir: opts.uploadDir,
      uploadPrefix: opts.uploadPrefix,
      // commander đặt hotlinkProtect=true khi có --hotlink-protect và false khi
      // có --no-hotlink-protect; KHÔNG truyền cờ nào thì nó là undefined nhờ
      // không khai báo default -> cmdAppSet bỏ qua, không ghi đè giá trị cũ.
      hotlinkProtect: opts.hotlinkProtect,
      hotlinkStrict: opts.hotlinkStrict,
      hotlinkAllow: (opts.hotlinkAllow ?? []).length > 0 ? opts.hotlinkAllow : undefined,
      maxBody: opts.maxBody,
      scanBlock: opts.scanBlock,
    })
  );

app
  .command("env-set <domain> <pairs...>")
  .description("cập nhật biến môi trường trong .env (dạng KEY=VALUE, có thể truyền nhiều)")
  .action((domain, pairs) => cmdAppEnvSet(domain, pairs));

// -------------------------------------------------------------- service ---
// Background service = ứng dụng Node.js/Bun chạy NGẦM (worker, bot, queue
// consumer, cron poller): KHÔNG domain, KHÔNG nginx/SSL, cổng là tuỳ chọn.
const service = program.command("service").description("quản lý ứng dụng chạy ngầm (background service, không domain/nginx)");

service
  .command("create <name>")
  .description("tạo background service: user hệ thống riêng (hoặc mượn user app web bằng --run-as), clone repo, systemd service (không nginx/domain)")
  .option("--port <port>", "cổng nội bộ (mặc định: KHÔNG cấp; chỉ đặt khi service tự bind, vd health-check)", (v) => parseInt(v, 10))
  .option("--repo <url>", "git repo để clone (bỏ trống để tạo worker mẫu rỗng)")
  .option("--branch <branch>", "branch git", "main")
  .option("--token <token>", "Personal Access Token để clone repo PRIVATE qua HTTPS (không hỏi mật khẩu)")
  .option("--ssh-key <path>", "deploy key để clone repo PRIVATE qua SSH — đường dẫn file HOẶC nội dung key")
  .addOption(new Option("--runtime <runtime>", "runtime chạy service").choices(["node", "bun"]).default("node"))
  .addOption(new Option("--package-manager <pm>", "trình quản lý gói phụ thuộc (mặc định: bun nếu runtime bun, còn lại npm)").choices(["npm", "pnpm", "yarn", "bun"]))
  .option("--install-cmd <cmd>", "lệnh cài dependencies (mặc định theo package manager)")
  .option("--build-cmd <cmd>", "lệnh build (vd: 'npm run build')")
  .option("--start-cmd <cmd>", "lệnh khởi động (mặc định 'npm start' theo package.json; vd: 'node worker.js')")
  .option("--db [engine]", "tạo kèm database riêng cho service (engine: mariadb | mysql | postgresql | mongodb; bỏ trống = engine mặc định/duy nhất đang cài)")
  .option("--redis", "cấp Redis DB riêng cho service (0-15)")
  .option("--redis-db <n>", "dùng Redis DB CHỈ ĐỊNH (cho phép dùng CHUNG với đơn vị khác)", (v) => parseInt(v, 10))
  .option("--share-redis-with <domain|name>", "dùng CHUNG Redis DB với app/service đã có — BẮT BUỘC nếu service này tiêu thụ hàng đợi của một web app")
  .option("--app-dir <path>", "monorepo: thư mục con chứa worker, tương đối so với mã nguồn (vd 'apps/worker')")
  .option(
    "--run-as <domain|name>",
    "chạy worker bằng user hệ thống của app/service ĐÃ CÓ (thay vì user riêng) — cần khi worker đọc/ghi FILE của app đó, vd nén ảnh trong thư mục upload"
  )
  .option(
    "--write-dir <path>",
    "cấp thêm quyền GHI vào đường dẫn tuyệt đối ngoài mã nguồn service (ReadWritePaths), lặp lại được",
    (v, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--env <KEY=VALUE...>", "biến môi trường bổ sung, có thể lặp lại nhiều lần", (v, prev: string[]) => [...prev, v], [] as string[])
  .action(async (name, opts) => {
    await cmdServiceCreate(name, {
      port: opts.port,
      repo: opts.repo,
      branch: opts.branch,
      token: opts.token,
      sshKey: opts.sshKey,
      runtime: opts.runtime,
      packageManager: opts.packageManager,
      installCmd: opts.installCmd,
      buildCmd: opts.buildCmd,
      startCmd: opts.startCmd,
      db: Boolean(opts.db),
      dbEngine: typeof opts.db === "string" ? opts.db : undefined,
      redis: Boolean(opts.redis),
      redisDb: opts.redisDb,
      shareRedisWith: opts.shareRedisWith,
      appDir: opts.appDir,
      runAs: opts.runAs,
      writeDirs: opts.writeDir ?? [],
      env: opts.env ?? [],
    });
  });

service
  .command("deploy <name>")
  .description("git pull + cài dependencies + build + restart service")
  .action(async (name) => cmdServiceDeploy(name));

service
  .command("set <name>")
  .description("đổi DANH TÍNH/QUYỀN GHI của service đã tạo (chạy bằng user app web, hoặc quay về user riêng)")
  .option("--run-as <domain|name>", "chuyển sang chạy bằng user hệ thống của app/service đã có")
  .option("--standalone", "quay về user hệ thống RIÊNG của service (cô lập hoàn toàn)")
  // prev có thể KHÔNG phải mảng: '--no-write-dir --write-dir /x' đặt giá trị
  // thành false trước rồi mới gọi reducer -> [...false] ném TypeError thô ra
  // màn hình. Bỏ qua false và để --write-dir đứng sau thắng.
  .option("--write-dir <path>", "đặt lại danh sách đường dẫn được GHI thêm (lặp lại được, thay thế danh sách cũ)", (v, prev: string[] | false) => [...(Array.isArray(prev) ? prev : []), v], [] as string[])
  .option("--no-write-dir", "bỏ hết đường dẫn ghi thêm")
  .action(async (name, opts) =>
    cmdServiceSet(name, {
      runAs: opts.runAs,
      standalone: Boolean(opts.standalone),
      // commander: --no-write-dir biến opts.writeDir thành false
      writeDirs: Array.isArray(opts.writeDir) ? opts.writeDir : [],
      clearWriteDirs: opts.writeDir === false,
    })
  );

service
  .command("remove <name>")
  .description("gỡ background service khỏi napp — chọn xoá mã nguồn / database (service systemd luôn bị gỡ)")
  .option("-y, --yes", "không hỏi xác nhận (mặc định: GIỮ mã nguồn + database)")
  .option("--all", "xoá tất cả: mã nguồn (+ user), database")
  .option("--source", "xoá luôn mã nguồn và user hệ thống của service")
  .option("--db", "xoá luôn database")
  .action(async (name, opts) =>
    cmdServiceRemove(name, {
      yes: Boolean(opts.yes),
      source: Boolean(opts.all || opts.source),
      database: Boolean(opts.all || opts.db),
    })
  );

service.command("list").description("liệt kê các background service đang quản lý").action(() => cmdServiceList());
service.command("restart <name>").description("khởi động lại service").action((name) => cmdServiceRestart(name));
service.command("stop <name>").description("dừng service").action((name) => cmdServiceStop(name));
service.command("start <name>").description("khởi động service").action((name) => cmdServiceStart(name));

service
  .command("logs <name>")
  .description("xem log của service (qua journalctl)")
  .option("-f, --follow", "theo dõi log liên tục")
  .option("-n, --lines <n>", "số dòng log", (v) => parseInt(v, 10), 100)
  .action((name, opts) => cmdServiceLogs(name, { follow: Boolean(opts.follow), lines: opts.lines }));

service
  .command("env-set <name> <pairs...>")
  .description("cập nhật biến môi trường trong .env (dạng KEY=VALUE, có thể truyền nhiều)")
  .action((name, pairs) => cmdServiceEnvSet(name, pairs));

// --------------------------------------------------------------- domain ---
const domain = program.command("domain").description("quản lý domain phụ (alias) gắn vào một app");
domain.command("add <appDomain> <alias>").description("thêm domain phụ trỏ vào app").action((a, b) => cmdDomainAdd(a, b));
domain.command("remove <appDomain> <alias>").description("gỡ domain phụ").action((a, b) => cmdDomainRemove(a, b));
domain.command("list <appDomain>").description("liệt kê domain của một app").action((a) => cmdDomainList(a));

// ----------------------------------------------------------------- cert ---
const cert = program.command("cert").description("quản lý SSL miễn phí qua Let's Encrypt (certbot)");
cert.command("list").description("liệt kê tất cả chứng chỉ").action(() => cmdCertList());
cert
  .command("status [domain]")
  .description("xem trạng thái chứng chỉ của một domain")
  .action((domain) => cmdCertStatus(domain));
cert
  .command("issue <domain>")
  .description("phát hành chứng chỉ SSL mới (chạy không tương tác)")
  .option("--no-www", "không bao gồm www.<domain>")
  .option("--email <email>", "email đăng ký Let's Encrypt (nhận cảnh báo hết hạn; nhớ cho lần sau)")
  .option("--register-without-email", "đăng ký KHÔNG email (không khuyến nghị)")
  .option("--no-redirect", "không tự thêm chuyển hướng HTTP -> HTTPS")
  .option("--extra <domain...>", "domain phụ khác cần đưa vào cùng chứng chỉ", (v, prev: string[]) => [...prev, v], [] as string[])
  .action((domain, opts) =>
    cmdCertIssue(domain, {
      noWww: !opts.www,
      extra: opts.extra ?? [],
      email: opts.email,
      registerWithoutEmail: Boolean(opts.registerWithoutEmail),
      redirect: opts.redirect,
    })
  );
cert
  .command("renew [domain]")
  .description("gia hạn chứng chỉ (bỏ trống domain để gia hạn tất cả)")
  .option("--force", "buộc gia hạn ngay cả khi chưa đến hạn")
  .action((domain, opts) => cmdCertRenew(domain, { force: Boolean(opts.force) }));
cert
  .command("revoke <domain>")
  .description("thu hồi và xoá chứng chỉ")
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (domain, opts) => cmdCertRevoke(domain, { yes: Boolean(opts.yes) }));

// ------------------------------------------------------------------- db ---
const db = program.command("db").description("quản lý database (MariaDB / MySQL / PostgreSQL / MongoDB) và các database engine");
const engineOpt = () => new Option("--engine <engine>", "database engine (bỏ trống = engine mặc định/duy nhất đang cài)");
db
  .command("create <name>")
  .description("tạo database + user riêng")
  .option("--user <user>", "tên user CSDL (mặc định trùng tên database)")
  .addOption(engineOpt())
  .action((name, opts) => cmdDbCreate(name, { user: opts.user, engine: opts.engine }));
db
  .command("drop <name>")
  .description("xoá database")
  .option("-y, --yes", "không hỏi xác nhận")
  .option("--user <user>", "xoá luôn user CSDL này")
  .addOption(engineOpt())
  .action(async (name, opts) => cmdDbDrop(name, { yes: Boolean(opts.yes), user: opts.user, engine: opts.engine }));
db
  .command("list")
  .description("liệt kê database (mặc định: mọi engine đã cài)")
  .option("--engine <engine>", "chỉ liệt kê một engine")
  .action((opts) => cmdDbList({ engine: opts.engine }));
db
  .command("backup <name>")
  .description("dump một database ra file nén")
  .addOption(engineOpt())
  .action((name, opts) => cmdDbBackup(name, { engine: opts.engine }));

const dbEngine = db.command("engine").description("chọn / cài / gỡ database engine (mặc định: mariadb)");
dbEngine.command("list").description("các engine hỗ trợ: đã chọn, đã cài, đang chạy, app nào đang dùng").action(() => cmdDbEngineList());
dbEngine
  .command("add <engine...>")
  .description("cài (nếu chưa có) và giao cho napp quản lý: mariadb | mysql | postgresql | mongodb")
  .option("--default", "đặt làm engine mặc định cho '--db' không kèm tên")
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (engines, opts) => cmdDbEngineAdd(engines, { default: Boolean(opts.default), yes: Boolean(opts.yes) }));
dbEngine
  .command("remove <engine>")
  .description("gỡ engine — từ chối nếu còn app/service dùng nó; mặc định GIỮ dữ liệu trên đĩa")
  .option("--force", "vẫn gỡ khi còn database không gắn với app nào (napp dump toàn bộ trước)")
  .option("--purge", "xoá VĨNH VIỄN cả cấu hình và thư mục dữ liệu")
  .option("-y, --yes", "không hỏi xác nhận (với --purge cần thêm --force)")
  .action(async (engine, opts) => cmdDbEngineRemove(engine, { purge: Boolean(opts.purge), force: Boolean(opts.force), yes: Boolean(opts.yes) }));
dbEngine.command("default <engine>").description("đặt engine mặc định cho '--db' không kèm tên").action((engine) => cmdDbEngineDefault(engine));
dbEngine
  .command("select <engines>")
  .description("chỉ GHI NHẬN lựa chọn, không cài ('mariadb,postgresql' hoặc 'none') — 'napp check --fix' sẽ cài theo")
  .action((engines) => cmdDbEngineSelect(engines));

// --------------------------------------------------------------- redis ---
const redis = program.command("redis").description("quản lý Redis dùng chung");
redis.command("info").description("xem INFO memory của Redis").action(() => cmdRedisInfo());
redis.command("allocations").description("xem cấp phát Redis DB (0-15) cho từng app").action(() => cmdRedisAllocations());
redis
  .command("flush <dbIndex>")
  .description("xoá toàn bộ dữ liệu trong một Redis DB index")
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (dbIndex, opts) => cmdRedisFlush(parseInt(dbIndex, 10), { yes: Boolean(opts.yes) }));

// -------------------------------------------------------------- backup ---
const backup = program.command("backup").description("sao lưu database + mã nguồn định kỳ");
backup
  .command("run")
  .description("chạy backup ngay (file nén gzip)")
  .addOption(new Option("--target <target>", "phạm vi backup").choices(["db", "files", "all"]).default("all"))
  .option("--database <name>", "chỉ backup một database cụ thể (mặc định: tất cả)")
  .option("--engine <engine>", "engine của --database, hoặc chỉ backup một engine (mặc định: mọi engine napp quản lý)")
  .option("--keep-days <n>", "retention: giữ backup trong N ngày", (v) => parseInt(v, 10), DEFAULT_RETENTION_DAYS)
  .option("--keep <n>", "(tuỳ chọn) giữ tối đa N bản gần nhất bất kể ngày", (v) => parseInt(v, 10))
  .option("--quiet", "giảm log (dùng khi chạy từ systemd timer)")
  .action((opts) =>
    cmdBackupRun({
      target: opts.target as BackupTarget,
      database: opts.database,
      engine: opts.engine,
      keepDays: opts.keepDays,
      keepCount: opts.keep,
      quiet: Boolean(opts.quiet),
    })
  );
backup
  .command("schedule")
  .description("lên lịch backup hàng ngày qua systemd timer")
  .option("--time <HH:MM>", "giờ chạy hàng ngày", "03:00")
  .option("--keep-days <n>", "retention: giữ backup trong N ngày", (v) => parseInt(v, 10), DEFAULT_RETENTION_DAYS)
  .addOption(new Option("--target <target>", "phạm vi backup").choices(["db", "files", "all"]).default("all"))
  .action((opts) => cmdBackupSchedule({ time: opts.time, keepDays: opts.keepDays, target: opts.target as BackupTarget }));
backup.command("unschedule").description("gỡ lịch backup tự động").action(() => cmdBackupUnschedule());
backup.command("list").description("liệt kê các bản backup hiện có").action(() => cmdBackupList());

// ------------------------------------------------------------- firewall ---
const firewall = program.command("firewall").description("quản lý tường lửa UFW");
firewall
  .command("sync")
  .description("đồng bộ UFW: deny mặc định, allow SSH, mở 80/443 cho mọi IP")
  .option("--ssh-port <port>", "cổng SSH (mặc định: tự dò từ sshd_config)", (v) => parseInt(v, 10))
  .option("--restrict-cloudflare", "(nâng cao) khoá origin: 80/443 CHỈ nhận từ dải IP Cloudflare (không cần cho việc lấy IP client thật)")
  .option("--extra-port <port...>", "cổng công khai bổ sung", (v, prev: number[]) => [...prev, parseInt(v, 10)], [] as number[])
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (opts) =>
    cmdFirewallSync({
      sshPort: opts.sshPort,
      restrictToCloudflare: Boolean(opts.restrictCloudflare),
      extraPorts: opts.extraPort ?? [],
      yes: Boolean(opts.yes),
      quiet: false,
    })
  );
firewall.command("status").description("xem trạng thái UFW").action(() => cmdFirewallStatus());

// ------------------------------------------------------------- fail2ban ---
const fail2ban = program.command("fail2ban").description("quản lý fail2ban");
fail2ban
  .command("setup")
  .description("áp cấu hình jail cho sshd + nginx + napp-ratelimit")
  .option("--ssh-port <port>", "cổng SSH (mặc định: tự dò)", (v) => parseInt(v, 10))
  .action((opts) => cmdFail2banSetup({ sshPort: opts.sshPort }));
fail2ban.command("status").description("xem trạng thái các jail").action(() => cmdFail2banStatus());
fail2ban.command("unban <jail> <ip>").description("gỡ chặn một IP khỏi jail").action((jail, ip) => cmdFail2banUnban(jail, ip));

// ----------------------------------------------------------------- tune ---
const tune = program.command("tune").description("tối ưu nginx/database/Redis/sysctl theo phần cứng thực tế");
tune.command("show").description("xem phần cứng phát hiện được + kế hoạch tối ưu (chưa áp dụng)").action(() => cmdTuneShow());
tune
  .command("apply")
  .description("áp cấu hình tối ưu — chạy lại bất cứ khi nào nâng cấp phần cứng server")
  .option("--db-ram-percent <n>", "ghi đè % RAM dành cho database (TỔNG mọi engine, chia đều giữa các engine)", (v) => parseInt(v, 10))
  .option("-y, --yes", "không hỏi xác nhận")
  .option("--skip-restart", "chỉ ghi file cấu hình, không restart service")
  .option(
    "--sync-units",
    "render lại TOÀN BỘ unit systemd từ template (đồng bộ hardening mới xuống unit cũ). " +
      "Mặc định chỉ sửa đúng các dòng cần sửa (--max-old-space-size, CPUWeight, IOWeight, MemoryHigh); " +
      "directive bạn sửa tay vẫn được giữ trong cả hai chế độ"
  )
  .option(
    "--service-weight <n>",
    `phần heap của background service so với web app, 0.1–1 (mặc định ${SERVICE_WEIGHT_DEFAULT} = web app gấp đôi worker; ` +
      `1 = chia đều như trước 1.25.0). Giá trị được LƯU nên mọi lần tạo/xoá app sau vẫn giữ đúng tỷ lệ`,
    (v) => parseFloat(v)
  )
  .action(async (opts) =>
    cmdTuneApply({
      dbRamPercent: opts.dbRamPercent,
      serviceWeight: opts.serviceWeight,
      yes: Boolean(opts.yes),
      skipRestart: Boolean(opts.skipRestart),
      syncUnits: Boolean(opts.syncUnits),
    })
  );

// ----------------------------------------------------------- cloudflare ---
const cloudflare = program.command("cloudflare").description("đồng bộ Cloudflare");
cloudflare
  .command("sync")
  .description("đồng bộ dải IP Cloudflare vào nginx để trích xuất đúng IP client thật")
  .option("--quiet", "giảm log")
  .action((opts) => cmdCloudflareSync({ quiet: Boolean(opts.quiet) }));
cloudflare
  .command("schedule")
  .description("lên lịch tự động đồng bộ IP Cloudflare vào nginx (systemd timer, hàng ngày)")
  .option("--time <HH:MM>", "giờ chạy hàng ngày", "01:00")
  .action((opts) => cmdCloudflareSchedule({ time: opts.time }));
cloudflare.command("unschedule").description("gỡ lịch tự động đồng bộ IP Cloudflare").action(() => cmdCloudflareUnschedule());

// ---------------------------------------------------------------- nginx ---
const nginx = program.command("nginx").description("cấu hình proxy dùng chung + hardening nginx");
nginx
  .command("harden")
  .description("chặn truy cập thẳng IP / Host lạ (default_server trả 444) + ẩn phiên bản nginx")
  .action(() => cmdNginxHarden());
nginx.command("unharden").description("gỡ cấu hình hardening nginx (khôi phục hành vi mặc định)").action(() => cmdNginxUnharden());
nginx
  .command("sync")
  .description(
    "áp cấu hình dùng chung cho vhost ĐÃ CÓ: bộ đệm đủ cho route SvelteKit sâu (hết 502), header Connection/WebSocket, " +
      "và chèn dòng include file location vào vhost tạo bằng bản napp cũ (chưa có -> mọi cấu hình napp ghi ra đều không tới được site đó) — giữ nguyên SSL của certbot"
  )
  .action(() => cmdNginxSync());
nginx
  .command("scanblock")
  .description("chặn quét lỗ hổng CMS/framework PHP (.php, /wp-admin/, /phpmyadmin/, /cgi-bin/ -> 444 + log riêng), áp cho MỌI site kể cả app tạo bằng bản napp cũ")
  .action(() => cmdNginxScanBlock());
nginx
  .command("unscanblock")
  .description("tắt chặn quét lỗ hổng trên toàn máy (một site riêng lẻ: napp app set <domain> --no-scan-block)")
  .action(() => cmdNginxUnscanBlock());

// ------------------------------------------------------------------ mem ---
// Phát hiện rò rỉ bộ nhớ SỚM (trước khi app chết) + chụp heap để tìm thủ phạm.
const mem = program.command("mem").description("theo dõi bộ nhớ, phát hiện rò rỉ sớm, chụp heap snapshot");
mem
  .command("status")
  .description("bộ nhớ hiện tại, số lần systemd âm thầm khởi động lại, và kết luận xu hướng của từng đơn vị")
  .action(() => cmdMemStatus());
mem.command("trend").description("xu hướng bộ nhớ từ dữ liệu đã lấy mẫu (cần ít nhất 6 giờ)").action(() => cmdMemTrend());
mem
  .command("watch")
  .description("bật lấy mẫu bộ nhớ định kỳ qua systemd timer — ĐÂY là thứ cho biết có rò rỉ TRƯỚC khi app chết")
  .option("--interval <phút>", "khoảng cách giữa hai lần lấy mẫu (mặc định 15)", (v) => parseInt(v, 10), 15)
  .action((opts) => cmdMemWatch({ interval: opts.interval }));
mem.command("unwatch").description("tắt lấy mẫu định kỳ (dữ liệu cũ vẫn giữ)").action(() => cmdMemUnwatch());
mem
  .command("sample")
  .description("lấy một mẫu ngay bây giờ (lệnh mà timer chạy)")
  .option("--quiet", "không in gì khi thành công")
  .action((opts) => cmdMemSample({ quiet: Boolean(opts.quiet) }));
mem
  .command("snapshot <app|service>")
  .description("chụp heap snapshot của tiến trình ĐANG CHẠY (app không chết) — cần bật 'napp mem guard' trước")
  .option("-y, --yes", "không hỏi xác nhận")
  .action(async (id, opts) => cmdMemSnapshot(id, { yes: Boolean(opts.yes) }));
mem
  .command("guard <app|service>")
  .description("bật cờ chẩn đoán rò rỉ (tự chụp heap trước khi OOM + cho phép chụp theo yêu cầu). CÓ restart đơn vị")
  .action((id) => cmdMemGuard(id, true));
mem.command("unguard <app|service>").description("tắt cờ chẩn đoán rò rỉ (có restart đơn vị)").action((id) => cmdMemGuard(id, false));

// ------------------------------------------------------- update/version ---
program.command("update").description("tự cập nhật napp lên bản mới nhất (OTA qua gist)").action(() => cmdUpdate());
program.command("version").description("in phiên bản hiện tại").action(() => cmdVersion());
program.command("changelog").description("xem lịch sử thay đổi").action(() => cmdChangelog());
program.command("install").description("cài napp vào /usr/local/bin + banner chào mừng SSH").action(() => cmdInstallSelf());
program.command("uninstall").description("gỡ napp khỏi /usr/local/bin (các app hiện có vẫn giữ nguyên)").action(() => cmdUninstallSelf());

// Không có subcommand -> mở menu tương tác.
if (process.argv.length <= 2) {
  runMenu().catch((e) => {
    printDie((e as Error).message);
    process.exit(1);
  });
} else {
  program.exitOverride();
  program.parseAsync(process.argv).catch((e) => {
    if (e instanceof NappError) {
      printDie(e.message);
      process.exit(1);
    }
    // Lỗi commander (vd: --help, tham số sai) đã tự in ra; không log lại.
    if (e && typeof e === "object" && "code" in e) {
      process.exit(0);
    }
    printDie((e as Error).message ?? String(e));
    if (execState.verbose) console.error(e);
    process.exit(1);
  });
}

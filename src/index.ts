import { Command, Option } from "commander";
import { legacy, legacyGroup, rawOpt, warnRenamed } from "./lib/cli";
import { audit, redactArgs, isStateChanging, cmdAuditShow } from "./lib/audit";
import { setDryRun, state as execState } from "./lib/exec";
import { printDie, NappError } from "./lib/log";
import { PromptCancelled } from "./lib/prompt";
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
  cmdAppEnvList,
  cmdAppEnvUnset,
  cmdAppSet,
  cmdAppShow,
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
  cmdServiceEnvList,
  cmdServiceEnvUnset,
  cmdServiceSet,
  cmdServiceShow,
} from "./commands/service";
import { cmdDomainAdd, cmdDomainRemove, cmdDomainList } from "./commands/domain";
import { cmdCertIssue, cmdCertRenew, cmdCertRevoke, cmdCertList, cmdCertStatus } from "./commands/cert";
import { cmdDbCreate, cmdDbDrop, cmdDbList, cmdDbBackup } from "./commands/db";
import { cmdDbEngineList, cmdDbEngineAdd, cmdDbEngineRemove, cmdDbEngineDefault, cmdDbEngineSelect } from "./commands/dbengine";
import { cmdRedisInfo, cmdRedisAllocations, cmdRedisFlush, cmdRedisList, cmdRedisShow, cmdRedisMigrate } from "./commands/redis";
import { cmdBackupRun, cmdBackupList, cmdBackupSchedule, cmdBackupUnschedule, cmdBackupScheduleShow, DEFAULT_RETENTION_DAYS, type BackupTarget } from "./commands/backup";
import { cmdFirewallSync, cmdFirewallStatus } from "./commands/firewall";
import { cmdFail2banSetup, cmdFail2banStatus, cmdFail2banUnban } from "./commands/fail2ban";
import { cmdTuneShow, cmdTuneApply } from "./commands/tune";
import { cmdMemStatus, cmdMemTrend, cmdMemSample, cmdMemWatch, cmdMemUnwatch, cmdMemWatchShow, cmdMemSnapshot, cmdMemGuard } from "./commands/mem";
import { SERVICE_WEIGHT_DEFAULT } from "./templates/tuning";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule, cmdCloudflareScheduleShow } from "./commands/cloudflare";
import { cmdNginxHarden, cmdNginxUnharden, cmdNginxSync, cmdNginxScanBlock, cmdNginxUnscanBlock, cmdNginxHardeningShow, cmdNginxScanBlockShow } from "./commands/nginx";
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
  .hook("preAction", (thisCmd, actionCmd) => {
    const opts = thisCmd.opts();
    setDryRun(Boolean(opts.dryRun));
    execState.verbose = Boolean(opts.verbose);
    // Nhật ký thao tác: nhớ lệnh đang chạy, ghi kết quả khi xong (xem cuối file).
    const path: string[] = [];
    for (let c: Command | null = actionCmd; c && c.parent; c = c.parent) path.unshift(c.name());
    const args = process.argv.slice(2);
    if (isStateChanging(path, args)) auditCommand = redactArgs(args).join(" ");
  });

// Lệnh đang chạy (đã che bí mật) — undefined với lệnh chỉ đọc.
let auditCommand: string | undefined;

// Danh sách lệnh do commander tự sinh trả lời "có những lệnh gì", nhưng không
// trả lời "gõ gì trước" và nhất là không nhắc các bước BẮT BUỘC sau khi nâng
// cấp napp — những bước mà bỏ qua thì server vẫn mang cấu hình cũ đã hỏng
// (Redis volatile-lru làm mất job BullMQ, bộ đệm 16k làm route SvelteKit sâu
// trả 502). Chỉ changelog nhắc là chưa đủ: gần như không ai đọc changelog.
program.addHelpText(
  "after",
  `
Ngữ pháp (mọi lệnh đều theo một khuôn):
  napp <resource> [<sub-resource>] <verb> [<id>] [--flags]
    list · show <id> · create <id> · update <id> · delete <id>
    set / unset         ghi / xoá giá trị (env, lựa chọn engine)
    enable / disable    mọi công tắc bật/tắt (lịch chạy, hardening, guard)
    apply               đưa hệ thống về đúng cấu hình napp mong muốn
    -y/--yes = bỏ hỏi xác nhận · --force = vượt một lần từ chối an toàn
  Ví dụ: napp app show <domain> · napp app env set <domain> K=V · napp backup schedule enable

Bắt đầu nhanh:
  sudo napp                      mở menu tương tác (gõ số, 0 để quay lại)
  sudo napp check --fix          kiểm tra + tự cài thành phần còn thiếu
                                 (database mặc định MariaDB; chọn khác: --db postgresql
                                  | mysql | mongodb | none, nhiều engine: --db mariadb,mongodb)
  sudo napp app create <domain> --repo <url> --db --redis
  sudo napp cert create <domain> --email <email>
  sudo napp tune apply           tối ưu theo phần cứng (chạy lại khi nâng cấp server)

Sau khi cập nhật napp (bản cũ để lại cấu hình đã hỏng, không tự sửa):
  sudo napp nginx apply          gỡ bộ đệm proxy 16k nội tuyến khỏi vhost cũ
                                 -> hết 502 'upstream sent too big header' ở
                                    route SvelteKit lồng sâu.
                                 Đồng thời chèn dòng 'include' file location vào
                                 vhost tạo bằng bản napp cũ, và BẬT chặn quét lỗ
                                 hổng (.php/wp-admin/phpmyadmin -> 444, log riêng)
  sudo napp fail2ban apply       bật jail 'napp-scanner' — ban IP quét ngay ở
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
  sudo napp app update <domain> --auto-static
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
  sudo napp mem show             bộ nhớ hiện tại + SỐ LẦN systemd đã âm thầm
                                 khởi động lại. Unit napp đều 'Restart=always'
                                 nên app rò rỉ chết rồi tự dậy, lặp nhiều ngày
  sudo napp mem watch enable     lấy mẫu định kỳ -> 'napp mem show --trend' kết
                                 luận được xu hướng (cần ít nhất 6 giờ dữ liệu)
  sudo napp mem guard enable <app>
                                 bật cờ Node tự chụp heap TRƯỚC khi chết vì OOM
  sudo napp mem snapshot <app>   chụp heap ngay, app vẫn chạy -> mở bằng
                                 Chrome DevTools > Memory để tìm thủ phạm

Worker của một app web (hai nửa của cùng một sản phẩm):
  sudo napp service create <name> --run-as <domain> --share-redis-with <domain>
       --run-as         chạy bằng user của app -> đọc/ghi được file của app
       --share-redis-with  chung keyspace -> hàng đợi mới chạy
  sudo napp service update <name> --run-as <domain>    (đổi cho service ĐÃ TẠO)

Tên lệnh trước 1.28 (app set, cert issue, nginx sync, backup run, ...) vẫn chạy.
Chi tiết từng lệnh: napp <lệnh> --help · lịch sử thay đổi: napp changelog
`
);

// ==========================================================================
// NGỮ PHÁP LỆNH (xem README "Ngữ pháp lệnh"):
//
//   napp <resource> [<sub-resource>] <verb> [<id>...] [--flags]
//
//   list · show <id> · create <id> · update <id> · delete <id>   (CRUD)
//   set / unset       ghi / xoá giá trị, không tác dụng phụ (env, lựa chọn engine)
//   enable / disable  MỌI công tắc bật/tắt (lịch chạy, hardening, guard)
//   apply             đưa hệ thống về đúng cấu hình napp mong muốn
//   hành động riêng   deploy start stop restart logs · renew · flush · snapshot sample · unban
//
// Mỗi lệnh được dựng bằng MỘT hàm (options + action) rồi đăng ký dưới tên mới,
// và — nếu từng có tên khác — dưới tên cũ dạng lệnh ẩn (lib/cli.ts `legacy`).
// ==========================================================================

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
  .description("kiểm tra bản vá bảo mật đang chờ, dịch vụ còn nạp thư viện cũ, database lộ ra mạng, CVE nginx, vòng đời Node.js")
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

// Cờ dùng chung ------------------------------------------------------------
const repeat = <T,>(parse: (v: string) => T) => (v: string, prev: T[]) => [...prev, parse(v)];
const collect = repeat((v) => v);
const nonEmpty = (v: string[] | undefined) => (v && v.length > 0 ? v : undefined);
const dbCreateOpt = (unit: string) =>
  new Option("--db [engine]", `tạo kèm database riêng cho ${unit} (mariadb | mysql | postgresql | mongodb; bỏ trống = engine mặc định/duy nhất đang cài)`);
const engineOpt = () => new Option("--engine <engine>", "database engine (bỏ trống = engine mặc định/duy nhất đang cài)");
const yesOpt = () => new Option("-y, --yes", "không hỏi xác nhận");
// Tên cờ cũ: vẫn nhận, không hiện trong --help.
const hiddenFlag = (flags: string) => new Option(flags).hideHelp();

// ------------------------------------------------------------------ app ---
const app = program.command("app").description("ứng dụng web Node.js/Bun (có domain, nginx, SSL)");

app
  .command("list")
  .description("liệt kê các app")
  .action(() => cmdAppList());

app
  .command("show <domain>")
  .description("xem cấu hình + trạng thái của một app")
  .action((domain) => cmdAppShow(domain));

app
  .command("create <domain>")
  .description("tạo app mới: user hệ thống riêng, clone repo, systemd service, nginx vhost")
  .option("--port <port>", "cổng nội bộ (mặc định: tự cấp phát 3000-3999)", (v) => parseInt(v, 10))
  .option("--repo <url>", "git repo để clone (bỏ trống để tạo app mẫu rỗng)")
  .option("--branch <branch>", "branch git", "main")
  .option("--allow-insecure-repo", "cho phép repo http:// hoặc git:// (KHÔNG mã hoá — chỉ dùng trong mạng nội bộ tin cậy)")
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
  .addOption(dbCreateOpt("app"))
  .option("--redis", "cấp Redis RIÊNG cho app (tiến trình riêng, có mật khẩu)")
  .option("--redis-db <n>", "KIỂU CŨ: dùng DB index trên Redis dùng chung (không mật khẩu, không cô lập)", (v) => parseInt(v, 10))
  .option("--share-redis-with <domain|name>", "dùng CHUNG Redis với app/service đã có (bắt buộc cho cặp web + worker)")
  .option("--app-dir <path>", "monorepo: thư mục con chứa app, tương đối so với mã nguồn (vd 'apps/backend')")
  .option("--max-body <size>", "client_max_body_size của nginx (mặc định 20M; tăng nếu app cho upload file lớn)")
  .option("--static-root <dir>", "thư mục asset build để NGINX trả thẳng thay vì qua Node (vd '<webRoot>/build/client')")
  .option("--upload-dir <dir>", "thư mục file NGƯỜI DÙNG TẢI LÊN lúc chạy — KHÁC --static-root, xem README (vd '<webRoot>/static/uploads')")
  .option("--upload-prefix <path>", "tiền tố URL của --upload-dir (mặc định '/uploads/')")
  .option("--hotlink-protect", "chỉ cho nhúng asset/ảnh từ domain của site (CORP do trình duyệt thực thi + kiểm tra Referer)")
  .option("--hotlink-strict", "chặt hơn: BỎ 'none'/'blocked' khỏi valid_referers — đổi lại MẤT ảnh preview khi chia sẻ link")
  .option("--hotlink-allow <domain...>", "domain NGOÀI cũng được phép nhúng, lặp lại được (vd 'partner.com' hoặc '*.cdn.net')", collect, [] as string[])
  .option(
    "--static-prefix <path...>",
    "tiền tố URL phục vụ từ --static-root, lặp lại được (SvelteKit: /_app/ · Nuxt: /_nuxt/ · Astro: /_astro/). Next.js dùng --static-alias",
    collect,
    [] as string[]
  )
  .option(
    "--static-alias <prefix=dir...>",
    "tiền tố URL phục vụ bằng 'alias', lặp lại được — dùng khi URL khác tên thư mục (Next.js: '/_next/static/=<webRoot>/.next/static')",
    collect,
    [] as string[]
  )
  .option("--auto-static", "tự nhận diện framework từ thư mục build và cho nginx trả thẳng asset (SvelteKit, Next.js, Nuxt, SolidStart, Astro)")
  .option("--env <KEY=VALUE...>", "biến môi trường bổ sung, lặp lại được", collect, [] as string[])
  .action(async (domain, opts) => {
    await cmdAppCreate(domain, {
      port: opts.port,
      repo: opts.repo,
      branch: opts.branch,
      allowInsecureRepo: Boolean(opts.allowInsecureRepo),
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
      staticPrefix: nonEmpty(opts.staticPrefix),
      staticAlias: nonEmpty(opts.staticAlias),
      autoStatic: Boolean(opts.autoStatic),
      uploadDir: opts.uploadDir,
      uploadPrefix: opts.uploadPrefix,
      hotlinkProtect: Boolean(opts.hotlinkProtect),
      hotlinkStrict: Boolean(opts.hotlinkStrict),
      hotlinkAllow: nonEmpty(opts.hotlinkAllow),
      env: opts.env ?? [],
    });
  });

const appUpdate = (c: Command) =>
  c
    .description("đổi cấu hình NGINX của app ĐÃ TẠO (asset tĩnh, file tải lên, chặn hotlink, giới hạn upload) — chỉ đổi đúng cờ được truyền")
    .option("--static-root <dir>", "thư mục asset build để NGINX trả thẳng thay vì qua Node")
    .option(
      "--static-prefix <path...>",
      "tiền tố URL phục vụ từ --static-root, lặp lại được (SvelteKit: /_app/ · Nuxt: /_nuxt/ · Astro: /_astro/). Next.js dùng --static-alias",
      collect,
      [] as string[]
    )
    .option(
      "--static-alias <prefix=dir...>",
      "tiền tố URL phục vụ bằng 'alias', lặp lại được — dùng khi URL khác tên thư mục (Next.js: '/_next/static/=<webRoot>/.next/static')",
      collect,
      [] as string[]
    )
    .option("--auto-static", "nhận diện framework từ thư mục build rồi áp cấu hình tĩnh phù hợp (SvelteKit, Next.js, Nuxt, SolidStart, Astro)")
    .option("--upload-dir <dir>", "thư mục file NGƯỜI DÙNG TẢI LÊN lúc chạy (khác --static-root)")
    .option("--upload-prefix <path>", "tiền tố URL của --upload-dir (mặc định '/uploads/')")
    .option("--hotlink-protect", "chỉ cho nhúng asset/ảnh từ domain của site (CORP + kiểm tra Referer)")
    .option("--no-hotlink-protect", "tắt chặn hotlink")
    .option("--hotlink-strict", "chặt hơn: BỎ 'none'/'blocked' khỏi valid_referers — đổi lại MẤT ảnh preview khi chia sẻ link")
    .option("--no-hotlink-strict", "quay lại mức mặc định (cho phép 'none'/'blocked')")
    .option("--hotlink-allow <domain...>", "domain NGOÀI cũng được phép nhúng, lặp lại được", collect, [] as string[])
    .option("--max-body <size>", "client_max_body_size của nginx (vd '100M')")
    .option("--scan-block", "bật lại chặn quét lỗ hổng cho site này (mặc định đã bật)")
    .option("--no-scan-block", "TẮT chặn quét lỗ hổng cho RIÊNG site này — chỉ cần khi site thật sự phục vụ .php qua upstream khác")
    .action((domain, opts) =>
      cmdAppSet(domain, {
        staticRoot: opts.staticRoot,
        staticPrefix: nonEmpty(opts.staticPrefix),
        staticAlias: nonEmpty(opts.staticAlias),
        autoStatic: Boolean(opts.autoStatic),
        uploadDir: opts.uploadDir,
        uploadPrefix: opts.uploadPrefix,
        // commander đặt hotlinkProtect=true khi có --hotlink-protect và false khi
        // có --no-hotlink-protect; KHÔNG truyền cờ nào thì nó là undefined nhờ
        // không khai báo default -> cmdAppSet bỏ qua, không ghi đè giá trị cũ.
        hotlinkProtect: opts.hotlinkProtect,
        hotlinkStrict: opts.hotlinkStrict,
        hotlinkAllow: nonEmpty(opts.hotlinkAllow),
        maxBody: opts.maxBody,
        scanBlock: opts.scanBlock,
      })
    );
appUpdate(app.command("update <domain>"));
legacy(app, "set <domain>", "app update <domain>", appUpdate);

const appDelete = (c: Command) =>
  c
    .description("gỡ app — service systemd luôn bị gỡ; mặc định xoá nginx + SSL, GIỮ mã nguồn + database")
    .addOption(yesOpt())
    .option("--source", "xoá luôn mã nguồn và user hệ thống của app")
    .option("--database", "xoá luôn database")
    .option("--all", "xoá tất cả: nginx, SSL, mã nguồn (+ user), database")
    .option("--keep-nginx", "giữ lại cấu hình nginx")
    .option("--keep-ssl", "giữ lại chứng chỉ SSL")
    .addOption(hiddenFlag("--db")) // tên cũ của --database
    .addOption(hiddenFlag("--keep-db")) // no-op từ bản cũ (database vốn được giữ)
    .action(async (domain, opts) =>
      cmdAppRemove(domain, {
        yes: Boolean(opts.yes),
        nginx: opts.all ? true : !opts.keepNginx,
        ssl: opts.all ? true : !opts.keepSsl,
        source: Boolean(opts.all || opts.source),
        database: opts.all ? true : Boolean(opts.database || opts.db) && !opts.keepDb,
      })
    );
appDelete(app.command("delete <domain>"));
legacy(app, "remove <domain>", "app delete <domain>", appDelete);

app.command("deploy <domain>").description("git pull + cài dependencies + build + restart").action(async (domain) => cmdAppDeploy(domain));
app.command("start <domain>").description("khởi động app").action((domain) => cmdAppStart(domain));
app.command("stop <domain>").description("dừng app").action((domain) => cmdAppStop(domain));
app.command("restart <domain>").description("khởi động lại app").action((domain) => cmdAppRestart(domain));
app
  .command("logs <domain>")
  .description("xem log của app (qua journalctl)")
  .option("-f, --follow", "theo dõi log liên tục")
  .option("-n, --lines <n>", "số dòng log", (v) => parseInt(v, 10), 100)
  .action((domain, opts) => cmdAppLogs(domain, { follow: Boolean(opts.follow), lines: opts.lines }));

// app env: biến môi trường trong .env của app
const appEnv = app.command("env").description("biến môi trường (.env) của app");
appEnv
  .command("list <domain>")
  .description("liệt kê biến trong .env (che giá trị bí mật)")
  .option("--reveal", "hiện cả giá trị bí mật")
  .action((domain, opts) => cmdAppEnvList(domain, { reveal: Boolean(opts.reveal) }));
const appEnvSet = (c: Command) =>
  c.description("ghi biến vào .env (KEY=VALUE, truyền được nhiều) — restart app để áp dụng").action((domain, pairs) => cmdAppEnvSet(domain, pairs));
appEnvSet(appEnv.command("set <domain> <pairs...>"));
legacy(app, "env-set <domain> <pairs...>", "app env set <domain> KEY=VALUE...", appEnvSet);
appEnv
  .command("unset <domain> <keys...>")
  .description("xoá biến khỏi .env — restart app để áp dụng")
  .action((domain, keys) => cmdAppEnvUnset(domain, keys));

// app alias: domain phụ trỏ vào cùng app
const appAlias = app.command("alias").description("domain phụ (alias) trỏ vào app");
const aliasList = (c: Command) => c.description("liệt kê domain của một app").action((d) => cmdDomainList(d));
const aliasCreate = (c: Command) => c.description("thêm domain phụ trỏ vào app").action((d, alias) => cmdDomainAdd(d, alias));
const aliasDelete = (c: Command) => c.description("gỡ domain phụ").action((d, alias) => cmdDomainRemove(d, alias));
aliasList(appAlias.command("list <domain>"));
aliasCreate(appAlias.command("create <domain> <alias>"));
aliasDelete(appAlias.command("delete <domain> <alias>"));
const legacyDomain = program.command("domain", { hidden: true });
legacy(legacyDomain, "list <appDomain>", "app alias list <domain>", aliasList);
legacy(legacyDomain, "add <appDomain> <alias>", "app alias create <domain> <alias>", aliasCreate);
legacy(legacyDomain, "remove <appDomain> <alias>", "app alias delete <domain> <alias>", aliasDelete);

// -------------------------------------------------------------- service ---
// Background service = ứng dụng Node.js/Bun chạy NGẦM (worker, bot, queue
// consumer, cron poller): KHÔNG domain, KHÔNG nginx/SSL, cổng là tuỳ chọn.
const service = program.command("service").description("ứng dụng chạy ngầm (worker, bot, queue consumer — không domain/nginx)");

service
  .command("list")
  .description("liệt kê các service")
  .action(() => cmdServiceList());

service
  .command("show <name>")
  .description("xem cấu hình + trạng thái của một service")
  .action((name) => cmdServiceShow(name));

service
  .command("create <name>")
  .description("tạo background service: user hệ thống riêng (hoặc mượn user app web bằng --run-as), clone repo, systemd service (không nginx/domain)")
  .option("--port <port>", "cổng nội bộ (mặc định: KHÔNG cấp; chỉ đặt khi service tự bind, vd health-check)", (v) => parseInt(v, 10))
  .option("--repo <url>", "git repo để clone (bỏ trống để tạo worker mẫu rỗng)")
  .option("--branch <branch>", "branch git", "main")
  .option("--allow-insecure-repo", "cho phép repo http:// hoặc git:// (KHÔNG mã hoá — chỉ dùng trong mạng nội bộ tin cậy)")
  .option("--token <token>", "Personal Access Token để clone repo PRIVATE qua HTTPS (không hỏi mật khẩu)")
  .option("--ssh-key <path>", "deploy key để clone repo PRIVATE qua SSH — đường dẫn file HOẶC nội dung key")
  .addOption(new Option("--runtime <runtime>", "runtime chạy service").choices(["node", "bun"]).default("node"))
  .addOption(new Option("--package-manager <pm>", "trình quản lý gói phụ thuộc (mặc định: bun nếu runtime bun, còn lại npm)").choices(["npm", "pnpm", "yarn", "bun"]))
  .option("--install-cmd <cmd>", "lệnh cài dependencies (mặc định theo package manager)")
  .option("--build-cmd <cmd>", "lệnh build (vd: 'npm run build')")
  .option("--start-cmd <cmd>", "lệnh khởi động (mặc định 'npm start' theo package.json; vd: 'node worker.js')")
  .addOption(dbCreateOpt("service"))
  .option("--redis", "cấp Redis RIÊNG cho service (tiến trình riêng, có mật khẩu)")
  .option("--redis-db <n>", "KIỂU CŨ: dùng DB index trên Redis dùng chung (không mật khẩu, không cô lập)", (v) => parseInt(v, 10))
  .option("--share-redis-with <domain|name>", "dùng CHUNG Redis với app/service đã có — BẮT BUỘC nếu service này tiêu thụ hàng đợi của một web app")
  .option("--app-dir <path>", "monorepo: thư mục con chứa worker, tương đối so với mã nguồn (vd 'apps/worker')")
  .option(
    "--run-as <domain|name>",
    "chạy worker bằng user hệ thống của app/service ĐÃ CÓ (thay vì user riêng) — cần khi worker đọc/ghi FILE của app đó, vd nén ảnh trong thư mục upload"
  )
  .option("--write-dir <path>", "cấp thêm quyền GHI vào đường dẫn tuyệt đối ngoài mã nguồn service (ReadWritePaths), lặp lại được", collect, [] as string[])
  .option("--env <KEY=VALUE...>", "biến môi trường bổ sung, lặp lại được", collect, [] as string[])
  .action(async (name, opts) => {
    await cmdServiceCreate(name, {
      port: opts.port,
      repo: opts.repo,
      branch: opts.branch,
      allowInsecureRepo: Boolean(opts.allowInsecureRepo),
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

const serviceUpdate = (c: Command) =>
  c
    .description("đổi DANH TÍNH/QUYỀN GHI của service đã tạo (chạy bằng user app web, hoặc quay về user riêng)")
    .option("--run-as <domain|name>", "chuyển sang chạy bằng user hệ thống của app/service đã có")
    .option("--standalone", "quay về user hệ thống RIÊNG của service (cô lập hoàn toàn)")
    // prev có thể KHÔNG phải mảng: '--no-write-dir --write-dir /x' đặt giá trị
    // thành false trước rồi mới gọi reducer -> [...false] ném TypeError thô ra
    // màn hình. Bỏ qua false và để --write-dir đứng sau thắng.
    .option(
      "--write-dir <path>",
      "đặt lại danh sách đường dẫn được GHI thêm (lặp lại được, thay thế danh sách cũ)",
      (v, prev: string[] | false) => [...(Array.isArray(prev) ? prev : []), v],
      [] as string[]
    )
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
serviceUpdate(service.command("update <name>"));
legacy(service, "set <name>", "service update <name>", serviceUpdate);

const serviceDelete = (c: Command) =>
  c
    .description("gỡ service — service systemd luôn bị gỡ; mặc định GIỮ mã nguồn + database")
    .addOption(yesOpt())
    .option("--source", "xoá luôn mã nguồn và user hệ thống của service")
    .option("--database", "xoá luôn database")
    .option("--all", "xoá tất cả: mã nguồn (+ user), database")
    .addOption(hiddenFlag("--db")) // tên cũ của --database
    .action(async (name, opts) =>
      cmdServiceRemove(name, {
        yes: Boolean(opts.yes),
        source: Boolean(opts.all || opts.source),
        database: Boolean(opts.all || opts.database || opts.db),
      })
    );
serviceDelete(service.command("delete <name>"));
legacy(service, "remove <name>", "service delete <name>", serviceDelete);

service.command("deploy <name>").description("git pull + cài dependencies + build + restart").action(async (name) => cmdServiceDeploy(name));
service.command("start <name>").description("khởi động service").action((name) => cmdServiceStart(name));
service.command("stop <name>").description("dừng service").action((name) => cmdServiceStop(name));
service.command("restart <name>").description("khởi động lại service").action((name) => cmdServiceRestart(name));
service
  .command("logs <name>")
  .description("xem log của service (qua journalctl)")
  .option("-f, --follow", "theo dõi log liên tục")
  .option("-n, --lines <n>", "số dòng log", (v) => parseInt(v, 10), 100)
  .action((name, opts) => cmdServiceLogs(name, { follow: Boolean(opts.follow), lines: opts.lines }));

const serviceEnv = service.command("env").description("biến môi trường (.env) của service");
serviceEnv
  .command("list <name>")
  .description("liệt kê biến trong .env (che giá trị bí mật)")
  .option("--reveal", "hiện cả giá trị bí mật")
  .action((name, opts) => cmdServiceEnvList(name, { reveal: Boolean(opts.reveal) }));
const serviceEnvSet = (c: Command) =>
  c.description("ghi biến vào .env (KEY=VALUE, truyền được nhiều) — restart service để áp dụng").action((name, pairs) => cmdServiceEnvSet(name, pairs));
serviceEnvSet(serviceEnv.command("set <name> <pairs...>"));
legacy(service, "env-set <name> <pairs...>", "service env set <name> KEY=VALUE...", serviceEnvSet);
serviceEnv
  .command("unset <name> <keys...>")
  .description("xoá biến khỏi .env — restart service để áp dụng")
  .action((name, keys) => cmdServiceEnvUnset(name, keys));

// ----------------------------------------------------------------- cert ---
const cert = program.command("cert").description("chứng chỉ SSL miễn phí qua Let's Encrypt (certbot)");
cert.command("list").description("liệt kê mọi chứng chỉ + hạn dùng").action(() => cmdCertList());
cert
  .command("show <domain>")
  .description("xem chứng chỉ của một domain")
  .action((domain) => cmdCertStatus(domain));
legacy(cert, "status [domain]", "cert show <domain> (hoặc cert list)", (c) => c.action((domain) => cmdCertStatus(domain)));
const certCreate = (c: Command) =>
  c
    .description("phát hành chứng chỉ SSL (không tương tác)")
    .option("--no-www", "không bao gồm www.<domain>")
    .option("--email <email>", "email đăng ký Let's Encrypt (nhận cảnh báo hết hạn; nhớ cho lần sau)")
    .option("--register-without-email", "đăng ký KHÔNG email (không khuyến nghị)")
    .option("--no-redirect", "không tự thêm chuyển hướng HTTP -> HTTPS")
    .option("--extra <domain...>", "domain phụ khác cần đưa vào cùng chứng chỉ", collect, [] as string[])
    .action((domain, opts) =>
      cmdCertIssue(domain, {
        noWww: !opts.www,
        extra: opts.extra ?? [],
        email: opts.email,
        registerWithoutEmail: Boolean(opts.registerWithoutEmail),
        redirect: opts.redirect,
      })
    );
certCreate(cert.command("create <domain>"));
legacy(cert, "issue <domain>", "cert create <domain>", certCreate);
const certDelete = (c: Command) =>
  c
    .description("thu hồi và xoá chứng chỉ")
    .addOption(yesOpt())
    .action(async (domain, opts) => cmdCertRevoke(domain, { yes: Boolean(opts.yes) }));
certDelete(cert.command("delete <domain>"));
legacy(cert, "revoke <domain>", "cert delete <domain>", certDelete);
cert
  .command("renew [domain]")
  .description("gia hạn chứng chỉ (bỏ trống domain để gia hạn tất cả)")
  .option("--force", "buộc gia hạn ngay cả khi chưa đến hạn")
  .action((domain, opts) => cmdCertRenew(domain, { force: Boolean(opts.force) }));

// ------------------------------------------------------------------- db ---
const db = program.command("db").description("database (MariaDB / MySQL / PostgreSQL / MongoDB) và database engine");
db
  .command("list")
  .description("liệt kê database (mặc định: mọi engine đã cài)")
  .addOption(engineOpt())
  .action((opts) => cmdDbList({ engine: opts.engine }));
db
  .command("create <name>")
  .description("tạo database + user riêng (in mật khẩu + DATABASE_URL MỘT lần)")
  .option("--user <user>", "tên user CSDL (mặc định trùng tên database)")
  .addOption(engineOpt())
  .action((name, opts) => cmdDbCreate(name, { user: opts.user, engine: opts.engine }));
const dbDelete = (c: Command) =>
  c
    .description("xoá database")
    .option("--user <user>", "xoá luôn user CSDL này")
    .addOption(engineOpt())
    .addOption(yesOpt())
    .action(async (name, opts) => cmdDbDrop(name, { yes: Boolean(opts.yes), user: opts.user, engine: opts.engine }));
dbDelete(db.command("delete <name>"));
legacy(db, "drop <name>", "db delete <name>", dbDelete);
legacy(db, "backup <name>", "backup create --database <name>", (c) => c.addOption(engineOpt()).action((name, opts) => cmdDbBackup(name, { engine: opts.engine })));

const dbEngine = db.command("engine").description("database engine: chọn / cài / gỡ (mặc định: mariadb)");
dbEngine.command("list").description("engine hỗ trợ: napp quản lý? đã cài? đang chạy? app nào dùng?").action(() => cmdDbEngineList());
const engineCreate = (c: Command) =>
  c
    .description("cài (nếu chưa có) và giao cho napp quản lý: mariadb | mysql | postgresql | mongodb")
    .option("--default", "đặt làm engine mặc định cho '--db' không kèm tên")
    .addOption(yesOpt())
    .action(async (engines, opts) => cmdDbEngineAdd(engines, { default: Boolean(opts.default), yes: Boolean(opts.yes) }));
engineCreate(dbEngine.command("create <engine...>"));
legacy(dbEngine, "add <engine...>", "db engine create <engine...>", engineCreate);
const engineDelete = (c: Command) =>
  c
    .description("gỡ engine — từ chối nếu còn app/service dùng nó; mặc định GIỮ dữ liệu trên đĩa")
    .option("--force", "vẫn gỡ khi còn database không gắn với app nào (napp dump toàn bộ trước)")
    .option("--purge", "xoá VĨNH VIỄN cả cấu hình và thư mục dữ liệu")
    .addOption(new Option("-y, --yes", "không hỏi xác nhận (với --purge cần thêm --force)"))
    .action(async (engine, opts) => cmdDbEngineRemove(engine, { purge: Boolean(opts.purge), force: Boolean(opts.force), yes: Boolean(opts.yes) }));
engineDelete(dbEngine.command("delete <engine>"));
legacy(dbEngine, "remove <engine>", "db engine delete <engine>", engineDelete);
dbEngine
  .command("update <engine>")
  .description("đổi thuộc tính của engine")
  .option("--default", "đặt làm engine mặc định cho '--db' không kèm tên")
  .action((engine, opts) => {
    if (!opts.default) throw new NappError("Không có gì để cập nhật. Dùng: napp db engine update <engine> --default");
    cmdDbEngineDefault(engine);
  });
legacy(dbEngine, "default <engine>", "db engine update <engine> --default", (c) => c.action((engine) => cmdDbEngineDefault(engine)));
const engineSet = (c: Command) =>
  c
    .description("GHI ĐÈ danh sách engine napp quản lý mà KHÔNG cài/gỡ gì ('mariadb,postgresql' hoặc 'none') — 'napp check --fix' cài theo")
    .action((engines) => cmdDbEngineSelect(engines));
engineSet(dbEngine.command("set <engines>"));
legacy(dbEngine, "select <engines>", "db engine set <engines>", engineSet);

// --------------------------------------------------------------- redis ---
const redis = program.command("redis").description("Redis: mỗi app (và worker dùng chung) một Redis RIÊNG có mật khẩu");
redis.command("list").description("mọi Redis riêng + đơn vị còn dùng Redis dùng chung kiểu cũ").action(() => cmdRedisList());
redis
  .command("show [unit]")
  .description("Redis của một app/service (bỏ trống = Redis dùng chung kiểu cũ)")
  .action((unit) => cmdRedisShow(unit));
legacy(redis, "info", "redis show", (c) => c.action(() => cmdRedisInfo()));
redis
  .command("migrate <unit>")
  .description("chuyển app/service (cùng các worker dùng chung DB) từ Redis dùng chung sang Redis RIÊNG — giữ nguyên dữ liệu, dừng vài giây")
  .addOption(yesOpt())
  .action(async (unit, opts) => cmdRedisMigrate(unit, { yes: Boolean(opts.yes) }));
const redisDb = redis.command("db").description("Redis DÙNG CHUNG kiểu cũ: các DB index 0-15");
const redisDbList = (c: Command) => c.description("DB index nào đang cấp cho app/service nào (Redis dùng chung)").action(() => cmdRedisAllocations());
redisDbList(redisDb.command("list"));
legacy(redis, "allocations", "redis db list", redisDbList);
const redisDbFlush = (c: Command) =>
  c
    .description("xoá TOÀN BỘ dữ liệu trong một DB index của Redis dùng chung")
    .addOption(yesOpt())
    .action(async (dbIndex, opts) => cmdRedisFlush(parseInt(dbIndex, 10), { yes: Boolean(opts.yes) }));
redisDbFlush(redisDb.command("flush <index>"));
legacy(redis, "flush <dbIndex>", "redis db flush <index>", redisDbFlush);

// -------------------------------------------------------------- backup ---
const backup = program.command("backup").description("sao lưu database + mã nguồn (file nén)");
backup.command("list").description("liệt kê các bản backup + dung lượng").action(() => cmdBackupList());
const backupCreate = (c: Command) =>
  c
    .description("backup ngay")
    .addOption(new Option("--target <target>", "phạm vi backup").choices(["db", "files", "all"]).default("all"))
    .option("--database <name>", "chỉ backup một database (mặc định: tất cả)")
    .option("--engine <engine>", "engine của --database, hoặc chỉ backup một engine (mặc định: mọi engine napp quản lý)")
    .option("--keep-days <n>", "giữ backup trong N ngày", (v) => parseInt(v, 10), DEFAULT_RETENTION_DAYS)
    .option("--keep-count <n>", "(tuỳ chọn) giữ tối đa N bản gần nhất bất kể ngày", (v) => parseInt(v, 10))
    .addOption(new Option("--keep <n>").argParser((v) => parseInt(v, 10)).hideHelp()) // tên cũ của --keep-count
    .option("--quiet", "giảm log (dùng khi chạy từ systemd timer)")
    .action((opts) =>
      cmdBackupRun({
        target: opts.target as BackupTarget,
        database: opts.database,
        engine: opts.engine,
        keepDays: opts.keepDays,
        keepCount: opts.keepCount ?? opts.keep,
        quiet: Boolean(opts.quiet),
      })
    );
backupCreate(backup.command("create"));
// VĨNH VIỄN: unit napp-backup.service tạo bởi napp < 1.28 gọi đúng tên này.
legacy(backup, "run", "backup create", backupCreate, { permanent: true });

const backupSchedule = backup.command("schedule").description("lịch backup tự động hàng ngày (systemd timer)");
backupSchedule
  .command("show")
  .description("lịch hiện tại, lần chạy tới/trước")
  .action(() => cmdBackupScheduleShow());
backupSchedule
  .command("enable")
  .description("bật (hoặc đổi) lịch backup hàng ngày")
  .option("--time <HH:MM>", "giờ chạy hàng ngày", "03:00")
  .option("--keep-days <n>", "giữ backup trong N ngày", (v) => parseInt(v, 10), DEFAULT_RETENTION_DAYS)
  .addOption(new Option("--target <target>", "phạm vi backup").choices(["db", "files", "all"]).default("all"))
  .action((opts) => cmdBackupSchedule({ time: opts.time, keepDays: opts.keepDays, target: opts.target as BackupTarget }));
backupSchedule.command("disable").description("tắt lịch backup tự động").action(() => cmdBackupUnschedule());
legacyGroup(backupSchedule, ["--time", "--keep-days", "--target"], "backup schedule enable", (args) =>
  cmdBackupSchedule({
    time: rawOpt(args, "--time") ?? "03:00",
    keepDays: parseInt(rawOpt(args, "--keep-days") ?? String(DEFAULT_RETENTION_DAYS), 10),
    target: (rawOpt(args, "--target") ?? "all") as BackupTarget,
  })
);
legacy(backup, "unschedule", "backup schedule disable", (c) => c.action(() => cmdBackupUnschedule()));

// ------------------------------------------------------------- firewall ---
const firewall = program.command("firewall").description("tường lửa UFW");
const firewallShow = (c: Command) => c.description("xem trạng thái UFW").action(() => cmdFirewallStatus());
firewallShow(firewall.command("show"));
legacy(firewall, "status", "firewall show", firewallShow);
const firewallApply = (c: Command) =>
  c
    .description("áp cấu hình UFW: deny mặc định, allow SSH, mở 80/443")
    .option("--ssh-port <port>", "cổng SSH (mặc định: tự dò từ sshd_config)", (v) => parseInt(v, 10))
    .option("--restrict-cloudflare", "(nâng cao) khoá origin: 80/443 CHỈ nhận từ dải IP Cloudflare (không cần cho việc lấy IP client thật)")
    .option("--extra-port <port...>", "cổng công khai bổ sung, lặp lại được", repeat((v) => parseInt(v, 10)), [] as number[])
    .addOption(yesOpt())
    .action(async (opts) =>
      cmdFirewallSync({
        sshPort: opts.sshPort,
        restrictToCloudflare: Boolean(opts.restrictCloudflare),
        extraPorts: opts.extraPort ?? [],
        yes: Boolean(opts.yes),
        quiet: false,
      })
    );
firewallApply(firewall.command("apply"));
legacy(firewall, "sync", "firewall apply", firewallApply);

// ------------------------------------------------------------- fail2ban ---
const fail2ban = program.command("fail2ban").description("fail2ban: tự ban IP brute-force / quét lỗ hổng");
const fail2banShow = (c: Command) => c.description("xem trạng thái các jail").action(() => cmdFail2banStatus());
fail2banShow(fail2ban.command("show"));
legacy(fail2ban, "status", "fail2ban show", fail2banShow);
const fail2banApply = (c: Command) =>
  c
    .description("áp cấu hình jail cho sshd + nginx + napp-ratelimit + napp-scanner")
    .option("--ssh-port <port>", "cổng SSH (mặc định: tự dò)", (v) => parseInt(v, 10))
    .action((opts) => cmdFail2banSetup({ sshPort: opts.sshPort }));
fail2banApply(fail2ban.command("apply"));
legacy(fail2ban, "setup", "fail2ban apply", fail2banApply);
fail2ban.command("unban <jail> <ip>").description("gỡ chặn một IP khỏi jail").action((jail, ip) => cmdFail2banUnban(jail, ip));

// ----------------------------------------------------------------- tune ---
const tune = program.command("tune").description("tối ưu nginx/database/Redis/sysctl/heap Node theo phần cứng thực tế");
tune.command("show").description("phần cứng phát hiện được + kế hoạch tối ưu (chưa áp dụng)").action(() => cmdTuneShow());
tune
  .command("apply")
  .description("áp cấu hình tối ưu — chạy lại bất cứ khi nào nâng cấp phần cứng server")
  .option("--db-ram-percent <n>", "ghi đè % RAM dành cho database (TỔNG mọi engine, chia đều giữa các engine)", (v) => parseInt(v, 10))
  .option(
    "--service-weight <n>",
    `phần heap của background service so với web app, 0.1–1 (mặc định ${SERVICE_WEIGHT_DEFAULT} = web app gấp đôi worker; ` +
      `1 = chia đều như trước 1.25.0). Giá trị được LƯU nên mọi lần tạo/xoá app sau vẫn giữ đúng tỷ lệ`,
    (v) => parseFloat(v)
  )
  .option(
    "--sync-units",
    "render lại TOÀN BỘ unit systemd từ template (đồng bộ hardening mới xuống unit cũ). " +
      "Mặc định chỉ sửa đúng các dòng cần sửa (--max-old-space-size, CPUWeight, IOWeight, MemoryHigh); " +
      "directive bạn sửa tay vẫn được giữ trong cả hai chế độ"
  )
  .option("--skip-restart", "chỉ ghi file cấu hình, không restart service")
  .addOption(yesOpt())
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
const cloudflare = program.command("cloudflare").description("dải IP Cloudflare -> nginx lấy đúng IP khách thật");
const cloudflareApply = (c: Command) =>
  c
    .description("tải dải IP Cloudflare mới nhất và áp vào nginx")
    .option("--quiet", "giảm log")
    .action((opts) => cmdCloudflareSync({ quiet: Boolean(opts.quiet) }));
cloudflareApply(cloudflare.command("apply"));
// VĨNH VIỄN: unit napp-cloudflare-sync.service tạo bởi napp < 1.28 gọi đúng tên này.
legacy(cloudflare, "sync", "cloudflare apply", cloudflareApply, { permanent: true });

const cloudflareSchedule = cloudflare.command("schedule").description("lịch tự động cập nhật dải IP Cloudflare (systemd timer)");
cloudflareSchedule.command("show").description("lịch hiện tại, lần chạy tới/trước").action(() => cmdCloudflareScheduleShow());
cloudflareSchedule
  .command("enable")
  .description("bật (hoặc đổi) lịch cập nhật hàng ngày")
  .option("--time <HH:MM>", "giờ chạy hàng ngày", "01:00")
  .action((opts) => cmdCloudflareSchedule({ time: opts.time }));
cloudflareSchedule.command("disable").description("tắt lịch tự động").action(() => cmdCloudflareUnschedule());
legacyGroup(cloudflareSchedule, ["--time"], "cloudflare schedule enable", (args) => cmdCloudflareSchedule({ time: rawOpt(args, "--time") ?? "01:00" }));
legacy(cloudflare, "unschedule", "cloudflare schedule disable", (c) => c.action(() => cmdCloudflareUnschedule()));

// ---------------------------------------------------------------- nginx ---
const nginx = program.command("nginx").description("cấu hình nginx dùng chung cho mọi site");
const nginxApply = (c: Command) =>
  c
    .description(
      "áp cấu hình dùng chung cho vhost ĐÃ CÓ: bộ đệm đủ cho route SvelteKit sâu (hết 502), header Connection/WebSocket, " +
        "và chèn dòng include file location vào vhost tạo bằng bản napp cũ — giữ nguyên SSL của certbot"
    )
    .action(() => cmdNginxSync());
nginxApply(nginx.command("apply"));
legacy(nginx, "sync", "nginx apply", nginxApply);

const hardening = nginx.command("hardening").description("chặn truy cập thẳng IP / Host lạ (default_server trả 444) + ẩn phiên bản nginx");
hardening.command("show").description("đang bật hay tắt").action(() => cmdNginxHardeningShow());
const hardeningEnable = (c: Command) => c.description("bật hardening").action(() => cmdNginxHarden());
const hardeningDisable = (c: Command) => c.description("tắt hardening (khôi phục hành vi mặc định của nginx)").action(() => cmdNginxUnharden());
hardeningEnable(hardening.command("enable"));
hardeningDisable(hardening.command("disable"));
legacy(nginx, "harden", "nginx hardening enable", hardeningEnable);
legacy(nginx, "unharden", "nginx hardening disable", hardeningDisable);

const scanBlock = nginx
  .command("scan-block")
  .description("chặn quét lỗ hổng CMS/framework PHP (.php, /wp-admin/, /phpmyadmin/, /cgi-bin/ -> 444 + log riêng) trên MỌI site");
scanBlock.command("show").description("đang bật hay tắt, site nào tự tắt riêng").action(() => cmdNginxScanBlockShow());
const scanBlockEnable = (c: Command) => c.description("bật trên toàn máy").action(() => cmdNginxScanBlock());
const scanBlockDisable = (c: Command) =>
  c.description("tắt trên toàn máy (một site riêng: napp app update <domain> --no-scan-block)").action(() => cmdNginxUnscanBlock());
scanBlockEnable(scanBlock.command("enable"));
scanBlockDisable(scanBlock.command("disable"));
legacy(nginx, "scanblock", "nginx scan-block enable", scanBlockEnable);
legacy(nginx, "unscanblock", "nginx scan-block disable", scanBlockDisable);

// ------------------------------------------------------------------ mem ---
// Phát hiện rò rỉ bộ nhớ SỚM (trước khi app chết) + chụp heap để tìm thủ phạm.
const mem = program.command("mem").description("bộ nhớ: phát hiện rò rỉ sớm, chụp heap snapshot");
mem
  .command("show")
  .description("bộ nhớ hiện tại, số lần systemd âm thầm khởi động lại, kết luận xu hướng của từng đơn vị")
  .option("--trend", "chỉ in xu hướng từ dữ liệu đã lấy mẫu (cần ít nhất 6 giờ)")
  .action((opts) => (opts.trend ? cmdMemTrend() : cmdMemStatus()));
legacy(mem, "status", "mem show", (c) => c.action(() => cmdMemStatus()));
legacy(mem, "trend", "mem show --trend", (c) => c.action(() => cmdMemTrend()));

const memWatch = mem.command("watch").description("lấy mẫu bộ nhớ định kỳ (systemd timer) — thứ cho biết có rò rỉ TRƯỚC khi app chết");
memWatch.command("show").description("lịch hiện tại, lần chạy tới/trước").action(() => cmdMemWatchShow());
memWatch
  .command("enable")
  .description("bật (hoặc đổi) lấy mẫu định kỳ")
  .option("--interval <phút>", "khoảng cách giữa hai lần lấy mẫu", (v) => parseInt(v, 10), 15)
  .action((opts) => cmdMemWatch({ interval: opts.interval }));
memWatch.command("disable").description("tắt lấy mẫu định kỳ (dữ liệu cũ vẫn giữ)").action(() => cmdMemUnwatch());
legacyGroup(memWatch, ["--interval"], "mem watch enable", (args) => cmdMemWatch({ interval: parseInt(rawOpt(args, "--interval") ?? "15", 10) }));
legacy(mem, "unwatch", "mem watch disable", (c) => c.action(() => cmdMemUnwatch()));

// Lệnh mà timer chạy — tên KHÔNG đổi (unit trên server gọi đúng tên này).
mem
  .command("sample")
  .description("lấy một mẫu ngay bây giờ (lệnh mà timer chạy)")
  .option("--quiet", "không in gì khi thành công")
  .action((opts) => cmdMemSample({ quiet: Boolean(opts.quiet) }));
mem
  .command("snapshot <app|service>")
  .description("chụp heap snapshot của tiến trình ĐANG CHẠY (không chết) — cần 'napp mem guard enable' trước")
  .addOption(yesOpt())
  .action(async (id, opts) => cmdMemSnapshot(id, { yes: Boolean(opts.yes) }));

const memGuard = mem.command("guard").description("cờ chẩn đoán rò rỉ của Node (tự chụp heap trước khi OOM + chụp theo yêu cầu)");
memGuard.command("enable <app|service>").description("bật — CÓ restart đơn vị").action((id) => cmdMemGuard(id, true));
memGuard.command("disable <app|service>").description("tắt — CÓ restart đơn vị").action((id) => cmdMemGuard(id, false));
// Trước 1.28: 'mem guard <id>' (lá, có tham số). Nhóm nhận tham số thừa làm id.
memGuard
  .argument("[id]")
  .allowExcessArguments()
  .action((id?: string) => {
    if (!id) throw new NappError("Thiếu lệnh con. Dùng: napp mem guard enable|disable <app|service>");
    warnRenamed("mem guard <id>", "mem guard enable <id>");
    cmdMemGuard(id, true);
  });
legacy(mem, "unguard <app|service>", "mem guard disable <app|service>", (c) => c.action((id) => cmdMemGuard(id, false)));

// ---------------------------------------------------------------- audit ---
const auditCmd = program.command("audit").description("nhật ký thao tác: ai đã làm gì qua napp, lúc nào, kết quả ra sao");
auditCmd
  .command("show")
  .description("xem các thao tác gần nhất (bí mật đã được che)")
  .option("-n, --last <n>", "số dòng", (v) => parseInt(v, 10), 50)
  .action((opts) => cmdAuditShow({ last: opts.last }));

// ------------------------------------------------------- update/version ---
program
  .command("update")
  .description("tự cập nhật napp lên bản mới nhất (OTA qua gist) — chỉ cài bản có chữ ký hợp lệ")
  .option("--allow-downgrade", "cho phép cài bản CŨ hơn bản đang chạy (mặc định từ chối, chống phát lại bản cũ có lỗ hổng)")
  .action((opts) => cmdUpdate({ allowDowngrade: Boolean(opts.allowDowngrade) }));
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
  program.parseAsync(process.argv).then(() => {
    if (auditCommand) audit({ command: auditCommand, via: "cli", result: "ok" });
  }).catch((e) => {
    if (auditCommand) {
      audit({
        command: auditCommand,
        via: "cli",
        result: e instanceof PromptCancelled ? "cancelled" : "error",
        error: e instanceof PromptCancelled ? undefined : (e as Error)?.message,
      });
    }
    if (e instanceof NappError) {
      printDie(e.message);
      process.exit(1);
    }
    // Ctrl+C / Ctrl+D ngay tại câu hỏi xác nhận: người dùng chủ động huỷ, không phải lỗi.
    if (e instanceof PromptCancelled) {
      console.error(e.message);
      process.exit(130);
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

import { Command, Option } from "commander";
import { setDryRun, state as execState } from "./lib/exec";
import { printDie, NappError } from "./lib/log";
import { NAPP_VERSION } from "./version";

import { cmdCheck } from "./commands/check";
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
} from "./commands/app";
import { cmdDomainAdd, cmdDomainRemove, cmdDomainList } from "./commands/domain";
import { cmdCertIssue, cmdCertRenew, cmdCertRevoke, cmdCertList, cmdCertStatus } from "./commands/cert";
import { cmdDbCreate, cmdDbDrop, cmdDbList, cmdDbBackup } from "./commands/db";
import { cmdRedisInfo, cmdRedisAllocations, cmdRedisFlush } from "./commands/redis";
import { cmdBackupRun, cmdBackupList, cmdBackupSchedule, cmdBackupUnschedule, DEFAULT_RETENTION_DAYS, type BackupTarget } from "./commands/backup";
import { cmdFirewallSync, cmdFirewallStatus } from "./commands/firewall";
import { cmdFail2banSetup, cmdFail2banStatus, cmdFail2banUnban } from "./commands/fail2ban";
import { cmdTuneShow, cmdTuneApply } from "./commands/tune";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule } from "./commands/cloudflare";
import { cmdNginxHarden, cmdNginxUnharden, cmdNginxSync } from "./commands/nginx";
import { cmdUpdate, cmdVersion, cmdChangelog } from "./commands/update";
import { cmdInstallSelf, cmdUninstallSelf } from "./commands/installSelf";
import { runMenu } from "./commands/menu";

const program = new Command();

program
  .name("napp")
  .description("napp — quản lý server lưu trữ nhiều ứng dụng Node.js/Bun (domain, SSL, systemd, MariaDB, Redis, nginx, fail2ban, UFW, Cloudflare, backup, tối ưu phần cứng, OTA update)")
  .version(NAPP_VERSION, "-V, --version")
  .option("--dry-run", "chỉ in ra các bước sẽ thực hiện, không thay đổi gì thật")
  .option("--verbose", "in chi tiết các lệnh hệ thống được thực thi")
  .hook("preAction", (thisCmd) => {
    const opts = thisCmd.opts();
    setDryRun(Boolean(opts.dryRun));
    execState.verbose = Boolean(opts.verbose);
  });

// ---------------------------------------------------------------- check ---
program
  .command("check")
  .description("kiểm tra môi trường máy chủ (Node.js, nginx, certbot, MariaDB, Redis, fail2ban, UFW)")
  .option("--fix", "tự cài đặt/khởi động các thành phần còn thiếu (cần sudo)")
  .option("-y, --yes", "không hỏi xác nhận khi dùng --fix")
  .action(async (opts) => cmdCheck({ fix: Boolean(opts.fix), yes: Boolean(opts.yes) }));

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
  .option("--db", "tạo kèm database MariaDB riêng cho app")
  .option("--redis", "cấp Redis DB riêng cho app (0-15)")
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
      redis: Boolean(opts.redis),
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
  .command("env-set <domain> <pairs...>")
  .description("cập nhật biến môi trường trong .env (dạng KEY=VALUE, có thể truyền nhiều)")
  .action((domain, pairs) => cmdAppEnvSet(domain, pairs));

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
const db = program.command("db").description("quản lý database MariaDB độc lập");
db.command("create <name>").description("tạo database + user riêng").option("--user <user>", "tên user CSDL (mặc định trùng tên database)").action((name, opts) => cmdDbCreate(name, opts.user));
db
  .command("drop <name>")
  .description("xoá database")
  .option("-y, --yes", "không hỏi xác nhận")
  .option("--user <user>", "xoá luôn user CSDL này")
  .action(async (name, opts) => cmdDbDrop(name, { yes: Boolean(opts.yes), user: opts.user }));
db.command("list").description("liệt kê database").action(() => cmdDbList());
db.command("backup <name>").description("dump database ra file .sql.gz").action((name) => cmdDbBackup(name));

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
  .option("--keep-days <n>", "retention: giữ backup trong N ngày", (v) => parseInt(v, 10), DEFAULT_RETENTION_DAYS)
  .option("--keep <n>", "(tuỳ chọn) giữ tối đa N bản gần nhất bất kể ngày", (v) => parseInt(v, 10))
  .option("--quiet", "giảm log (dùng khi chạy từ systemd timer)")
  .action((opts) =>
    cmdBackupRun({
      target: opts.target as BackupTarget,
      database: opts.database,
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
const tune = program.command("tune").description("tối ưu nginx/MariaDB/Redis/sysctl theo phần cứng thực tế");
tune.command("show").description("xem phần cứng phát hiện được + kế hoạch tối ưu (chưa áp dụng)").action(() => cmdTuneShow());
tune
  .command("apply")
  .description("áp cấu hình tối ưu — chạy lại bất cứ khi nào nâng cấp phần cứng server")
  .option("--db-ram-percent <n>", "ghi đè % RAM dành cho InnoDB buffer pool", (v) => parseInt(v, 10))
  .option("-y, --yes", "không hỏi xác nhận")
  .option("--skip-restart", "chỉ ghi file cấu hình, không restart service")
  .action(async (opts) => cmdTuneApply({ dbRamPercent: opts.dbRamPercent, yes: Boolean(opts.yes), skipRestart: Boolean(opts.skipRestart) }));

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
const nginx = program.command("nginx").description("bảo vệ / hardening nginx");
nginx
  .command("harden")
  .description("chặn truy cập thẳng IP / Host lạ (default_server trả 444) + ẩn phiên bản nginx")
  .action(() => cmdNginxHarden());
nginx.command("unharden").description("gỡ cấu hình hardening nginx (khôi phục hành vi mặc định)").action(() => cmdNginxUnharden());
nginx
  .command("sync")
  .description("cập nhật cấu hình proxy dùng chung + vá vhost cũ (sửa header Connection/WebSocket) — giữ nguyên SSL")
  .action(() => cmdNginxSync());

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

import { existsSync, rmSync } from "node:fs";
import { execCapture, runCmd, runAs, ensureDir, requireRoot, commandExists, writeFile, appendFile } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { validateDomain, validatePort, validateRepoUrl, validateBranch, validateEnvKey } from "../lib/validate";
import {
  AppRecord,
  Runtime,
  PackageManager,
  getApp,
  requireApp,
  upsertApp,
  removeApp as removeAppFromState,
  allocatePort,
  allocateRedisDb,
  userFor,
  serviceNameFor,
  WWW_ROOT,
  NGINX_AVAILABLE,
  NGINX_ENABLED,
  SYSTEMD_DIR,
  loadState,
} from "../lib/state";
import { acquireLock } from "../lib/lock";
import { createDatabase, dropDatabase } from "../lib/mysql";
import { mergeEnvFile } from "../lib/envfile";
import { renderAppNginxConf } from "../templates/nginx";
import { ensureNappProxyConf } from "./nginx";
import { renderAppSystemdService, execStartLine } from "../templates/systemd";
import { detectHardware } from "../lib/hardware";
import { nodeMaxOldSpaceMB } from "../templates/tuning";
import { ipv6Available } from "../lib/network";

export interface CreateAppOptions {
  port?: number;
  repo?: string;
  branch: string;
  runtime: Runtime;
  packageManager?: PackageManager; // không truyền -> suy ra theo runtime (bun->bun, node->npm)
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  db: boolean;
  redis: boolean;
  env: string[]; // "KEY=VALUE"
}

// Trình quản lý gói mặc định khi người dùng không chỉ định: runtime bun dùng
// bun, còn lại dùng npm (luôn có sẵn cùng Node).
export function defaultPackageManager(runtime: Runtime): PackageManager {
  return runtime === "bun" ? "bun" : "npm";
}

// Lệnh cài dependencies theo từng package manager. TẤT CẢ đều "lockfile-aware":
// nếu có lockfile thì cài đúng theo lock (nhanh, tất định) và fallback cài
// thường khi lock lệch; nếu KHÔNG có lockfile (app mẫu / repo chưa commit lock)
// thì cài thẳng để tránh lỗi kiểu `npm ci` EUSAGE.
function defaultInstallCmd(pm: PackageManager): string {
  switch (pm) {
    case "bun":
      return "bun install --production";
    case "pnpm":
      return "if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile || pnpm install --prod; else pnpm install --prod; fi";
    case "yarn":
      // yarn classic hiểu --frozen-lockfile; yarn berry hiểu --immutable — thử lần lượt cho tương thích cả hai.
      return "if [ -f yarn.lock ]; then yarn install --production --frozen-lockfile || yarn install --immutable || yarn install; else yarn install --production || yarn install; fi";
    case "npm":
    default:
      return "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --omit=dev || npm install --omit=dev; else npm install --omit=dev; fi";
  }
}

// Lệnh khởi động mặc định. Runtime bun luôn chạy bằng `bun run start`. Runtime
// node chạy script "start" qua chính package manager đã chọn (npm/pnpm/yarn);
// nếu lỡ ghép node + bun thì dùng npm cho an toàn (npm luôn có cùng Node).
function defaultStartCmd(runtime: Runtime, pm: PackageManager): string {
  if (runtime === "bun") return "bun run start";
  return pm === "bun" ? "npm start" : `${pm} start`;
}

// Kiểm tra một lệnh có sẵn Ở MỨC HỆ THỐNG không (/usr, /opt, /bin) — tức MỌI user
// (kể cả app user chạy qua systemd / login shell) đều gọi được. Khác commandExists
// (chỉ dò PATH của root): pnpm/bun cài trong home của root sẽ KHÔNG tính là hệ
// thống, và đó chính là bẫy khiến bước cài deps của app user báo 'command not found'.
function commandExistsSystemWide(cmd: string): boolean {
  const res = execCapture("bash", ["-lc", `p="$(command -v ${cmd} 2>/dev/null)" && readlink -f "$p"`]);
  if (res.code !== 0) return false;
  return /^\/(usr|opt|bin|sbin)\//.test(res.stdout.trim());
}

// Đảm bảo trình quản lý gói dùng được ở mức hệ thống trước khi tạo app. npm đi
// kèm Node. pnpm/yarn thiếu thì cài global qua npm (-> /usr/bin, mọi user thấy).
// bun phải được cài sẵn system-wide (do install.sh) — thiếu thì báo lỗi rõ ràng.
function ensurePackageManager(pm: PackageManager): void {
  if (pm === "npm") return;
  if (commandExistsSystemWide(pm)) return;
  if (pm === "bun") {
    die(
      "bun chưa được cài ở mức hệ thống. Cài lại bằng install.sh (mặc định có cài bun), hoặc:\n" +
        "  sudo bash -c 'export BUN_INSTALL=/usr/local; curl -fsSL https://bun.sh/install | bash'\n" +
        "rồi thử lại — hoặc chọn package manager khác."
    );
  }
  info(`'${pm}' chưa có ở mức hệ thống — đang cài global bằng 'npm install -g ${pm}'...`);
  runCmd("npm", ["install", "-g", pm]);
  if (!commandExistsSystemWide(pm)) {
    die(`Đã chạy 'npm install -g ${pm}' nhưng '${pm}' vẫn chưa dùng được ở mức hệ thống. Hãy cài '${pm}' thủ công rồi thử lại.`);
  }
  ok(`Đã cài '${pm}' ở mức hệ thống.`);
}

// Cân đối heap V8 giữa TẤT CẢ app trên máy: heap mỗi app node = ngân sách RAM
// cho app / tổng số app (xem nodeMaxOldSpaceMB). Ghi lại unit systemd cho mọi
// app (đồng thời đồng bộ hardening mới), daemon-reload, và tùy chọn restart để
// áp ngay. Gọi khi số app thay đổi (tạo/xoá) và khi `napp tune apply`.
// Trả về số MB heap/app đã áp (0 nếu không có app nào).
export function applyNodeHeaps(opts: { restart: boolean; skipRestartFor?: string } = { restart: false }): number {
  const apps = Object.values(loadState().apps);
  if (apps.length === 0) return 0;
  const heapMB = nodeMaxOldSpaceMB(detectHardware(), apps.length);
  for (const app of apps) {
    const nodeOptions = app.nodeRuntime === "node" ? `--max-old-space-size=${heapMB}` : undefined;
    writeFile(`${SYSTEMD_DIR}/${serviceNameFor(app.domain)}.service`, renderAppSystemdService(app, execStartLine(app.startCmd), { nodeOptions }), 0o644);
  }
  runCmd("systemctl", ["daemon-reload"]);
  if (opts.restart) {
    for (const app of apps) {
      if (app.domain === opts.skipRestartFor) continue;
      runCmd("systemctl", ["restart", serviceNameFor(app.domain)], { silentFail: true });
    }
  }
  return heapMB;
}

function assertSiteAbsent(domain: string, user: string, port: number | undefined): void {
  const conflicts: string[] = [];
  const webRoot = `${WWW_ROOT}/${domain}`;
  if (existsSync(webRoot)) conflicts.push(`thư mục mã nguồn: ${webRoot}`);
  const ngxConf = `${NGINX_AVAILABLE}/${domain}.conf`;
  if (existsSync(ngxConf)) conflicts.push(`cấu hình nginx: ${ngxConf}`);
  const ngxLink = `${NGINX_ENABLED}/${domain}.conf`;
  if (existsSync(ngxLink)) conflicts.push(`symlink nginx: ${ngxLink}`);
  const svc = `${SYSTEMD_DIR}/${serviceNameFor(domain)}.service`;
  if (existsSync(svc)) conflicts.push(`systemd unit: ${svc}`);
  if (execCapture("id", [user]).code === 0) conflicts.push(`user hệ thống: ${user}`);
  if (getApp(domain)) conflicts.push(`registry: đã có trong ${`/etc/napp/state.json`}`);

  if (conflicts.length > 0) {
    die(
      `Website '${domain}' (hoặc tài nguyên cùng tên) ĐÃ TỒN TẠI — không tạo trùng.\n` +
        conflicts.map((c) => `  - ${c}`).join("\n") +
        `\n  Muốn tạo lại? Hãy xoá trước bằng: napp app remove ${domain}`
    );
  }
}

export async function cmdAppCreate(domain: string, opts: CreateAppOptions): Promise<void> {
  requireRoot();
  validateDomain(domain);
  validateBranch(opts.branch);
  if (opts.repo) validateRepoUrl(opts.repo);

  const user = userFor(domain);
  const webRoot = `${WWW_ROOT}/${domain}`;
  const port = allocatePort(opts.port);
  validatePort(port);
  const serviceName = serviceNameFor(domain);

  assertSiteAbsent(domain, user, port);

  const pm: PackageManager = opts.packageManager ?? defaultPackageManager(opts.runtime);

  // Runtime engine phải chạy được (app node chạy bằng node; app bun chạy bằng bun).
  if (opts.runtime === "node" && !commandExists("node")) {
    die("Node.js chưa được cài. Chạy 'napp check --fix' trước.");
  }
  if (opts.runtime === "bun" && !commandExistsSystemWide("bun")) {
    die(
      "bun chưa được cài ở mức hệ thống (runtime=bun cần bun để chạy). Cài lại bằng install.sh\n" +
        "  (mặc định có cài bun), hoặc: sudo bash -c 'export BUN_INSTALL=/usr/local; curl -fsSL https://bun.sh/install | bash'\n" +
        "rồi thử lại — hoặc chọn runtime node."
    );
  }
  // Trình quản lý gói phải dùng được Ở MỨC HỆ THỐNG (app user + systemd đều thấy).
  // Tự cài pnpm/yarn qua npm nếu thiếu. Làm TRƯỚC khi tạo tài nguyên để fail sớm,
  // không phải tạo rồi rollback.
  ensurePackageManager(pm);
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");

  const release = acquireLock(domain);
  let rollbackActive = true;
  let dbCreatedName: string | undefined; // set ngay sau khi createDatabase() thành công, để rollback biết cần xoá
  const rollback = () => {
    if (!rollbackActive) return;
    warn("Tạo app thất bại — đang hoàn tác các thay đổi đã thực hiện...");
    try {
      runCmd("rm", ["-f", `${NGINX_ENABLED}/${domain}.conf`, `${NGINX_AVAILABLE}/${domain}.conf`], { silentFail: true });
      runCmd("bash", ["-lc", "nginx -t >/dev/null 2>&1 && systemctl reload nginx || true"], { silentFail: true });
      runCmd("systemctl", ["stop", serviceName], { silentFail: true });
      runCmd("systemctl", ["disable", serviceName], { silentFail: true });
      runCmd("rm", ["-f", `${SYSTEMD_DIR}/${serviceName}.service`], { silentFail: true });
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      if (existsSync(webRoot)) rmSync(webRoot, { recursive: true, force: true });
      if (execCapture("id", [user]).code === 0) {
        runCmd("userdel", ["-r", user], { silentFail: true });
      }
      if (dbCreatedName) {
        try {
          dropDatabase(dbCreatedName, dbCreatedName);
        } catch {
          /* đã cảnh báo bên trong dropDatabase/runCmd nếu có lỗi; không chặn phần rollback còn lại */
        }
      }
      warn(`Đã hoàn tác. Hệ thống trở lại trạng thái trước khi tạo '${domain}'.`);
    } finally {
      release();
    }
  };

  try {
    section(`Tạo app ${domain}`);
    info(`Runtime ${opts.runtime}, quản lý gói ${pm}, cổng ${port}, user hệ thống ${user}`);

    // --- user hệ thống riêng, cô lập với các app khác ---
    runCmd("useradd", ["--system", "--create-home", "--home-dir", `/home/${user}`, "--shell", "/usr/sbin/nologin", user]);
    ok(`Đã tạo user hệ thống ${user}`);

    // --- thư mục mã nguồn ---
    ensureDir(webRoot);
    runCmd("chown", [`${user}:${user}`, webRoot]);

    if (opts.repo) {
      info(`Đang clone ${opts.repo} (branch ${opts.branch})...`);
      runAs(user, "git", ["clone", "--branch", opts.branch, "--depth", "1", opts.repo, webRoot]);
    } else {
      info("Không có --repo — tạo app mẫu tối giản để bạn tự đưa mã nguồn lên sau...");
      runAs(user, "bash", [
        "-lc",
        `cat > ${JSON.stringify(webRoot + "/package.json")} <<'EOF'
{
  "name": "${domain.replace(/[^a-z0-9-]/gi, "-")}",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node server.js" }
}
EOF
cat > ${JSON.stringify(webRoot + "/server.js")} <<'EOF'
// File tạm do napp tạo — hãy thay bằng mã nguồn thật của bạn.
const http = require("http");
const port = process.env.PORT || ${port};
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Website ${domain} đang được thiết lập bởi napp.");
}).listen(port, () => console.log("listening on " + port));
EOF`,
      ]);
    }

    const installCmd = opts.installCmd ?? defaultInstallCmd(pm);
    const buildCmd = opts.buildCmd ?? "";
    const startCmd = opts.startCmd ?? defaultStartCmd(opts.runtime, pm);

    if (existsSync(`${webRoot}/package.json`) || opts.repo) {
      info("Đang cài dependencies...");
      runAs(user, "bash", ["-lc", installCmd], { cwd: webRoot });
      if (buildCmd) {
        info("Đang build...");
        runAs(user, "bash", ["-lc", buildCmd], { cwd: webRoot });
      }
    }

    // --- database (tuỳ chọn) ---
    let dbInfo: { name: string; user: string; password: string } | undefined;
    if (opts.db) {
      dbInfo = createDatabase(user, user);
      dbCreatedName = dbInfo.name;
      ok(`Đã tạo database '${dbInfo.name}' + user CSDL '${dbInfo.user}'@'localhost'`);
    }

    // --- redis (tuỳ chọn) ---
    let redisDbIndex: number | undefined;
    if (opts.redis) {
      redisDbIndex = allocateRedisDb();
      if (redisDbIndex === undefined) {
        warn("Đã hết database Redis riêng (0-15). Bỏ qua cấp DB riêng — hãy dùng key-prefix trong app thay vì DB riêng.");
      } else {
        ok(`Đã cấp Redis DB #${redisDbIndex} cho app này`);
      }
    }

    // --- .env ---
    const envUpdates: Record<string, string> = {
      NODE_ENV: "production",
      PORT: String(port),
      APP_URL: `http://${domain}`,
      // --- App chạy sau reverse proxy (nginx) ---
      // adapter-node của SvelteKit mặc định KHÔNG tin các header X-Forwarded-*,
      // nên app tưởng mình đang chạy HTTP kể cả khi người dùng vào bằng HTTPS
      // (nginx mới là chỗ kết thúc TLS). Hệ quả: mọi đoạn code kiểu "chưa https
      // thì redirect sang https" sẽ LẶP VÔ HẠN, cookie Secure và kiểm tra CSRF
      // cũng sai theo. Ba biến dưới đây bảo adapter-node đọc header do nginx gửi.
      // Framework khác không hiểu thì đơn giản là bỏ qua — vô hại.
      //
      // ĐẶC BIỆT với SvelteKit — kiểm tra CSRF: adapter-node so Origin của trình
      // duyệt với origin server tự suy ra và CHẶN mọi POST/form action bằng lỗi
      // 403 "Cross-site POST form submissions are forbidden" nếu hai bên lệch.
      // Sau proxy server chỉ thấy http://127.0.0.1:<port> nên rất dễ lệch; cặp
      // PROTOCOL_HEADER + HOST_HEADER cho adapter dựng lại đúng https://<domain>
      // từ header nginx -> form action hết bị 403 mà KHÔNG cần hardcode ORIGIN.
      //
      // CỐ Ý không đặt ORIGIN cứng: để trống thì adapter-node tự dựng origin từ
      // PROTOCOL_HEADER + HOST_HEADER nên chạy đúng cả TRƯỚC và SAU khi có SSL.
      // Đặt ORIGIN=https://... ngay lúc tạo app sẽ sai vì cert chưa được cấp.
      // (Gợi ý bật ORIGIN thủ công được ghi dạng comment vào .env bên dưới.)
      PROTOCOL_HEADER: "x-forwarded-proto",
      HOST_HEADER: "host",
      ADDRESS_HEADER: "x-forwarded-for",
      // Số proxy TIN CẬY đứng trước app, đếm từ phải qua trong X-Forwarded-For.
      // 1 = chỉ có nginx. Nếu đặt thêm CDN/WAF trước nginx thì tăng lên 2.
      XFF_DEPTH: "1",
    };
    if (dbInfo) {
      envUpdates.DB_CONNECTION = "mysql";
      envUpdates.DB_HOST = "127.0.0.1";
      envUpdates.DB_PORT = "3306";
      envUpdates.DB_DATABASE = dbInfo.name;
      envUpdates.DB_USERNAME = dbInfo.user;
      envUpdates.DB_PASSWORD = dbInfo.password;
    }
    if (redisDbIndex !== undefined) {
      envUpdates.REDIS_HOST = "127.0.0.1";
      envUpdates.REDIS_PORT = "6379";
      envUpdates.REDIS_DB = String(redisDbIndex);
      envUpdates.REDIS_URL = `redis://127.0.0.1:6379/${redisDbIndex}`;
    }
    for (const kv of opts.env) {
      const eq = kv.indexOf("=");
      if (eq === -1) die(`--env phải theo dạng KEY=VALUE, nhận được: '${kv}'`);
      const key = kv.slice(0, eq);
      validateEnvKey(key);
      envUpdates[key] = kv.slice(eq + 1);
    }
    mergeEnvFile(`${webRoot}/.env`, envUpdates, 0o600);
    // Khối GỢI Ý (comment) về CSRF của SvelteKit — mergeEnvFile chỉ ghi KEY=VALUE
    // và lược bỏ comment, nên phải append riêng ở đây. Chỉ có trong .env "mẫu"
    // lúc tạo app; lần `napp app env set` sau sẽ ghi lại file và bỏ khối này —
    // không sao, nó chỉ là hướng dẫn, PROTOCOL_HEADER/HOST_HEADER ở trên mới là
    // phần thực sự làm CSRF chạy đúng.
    appendFile(
      `${webRoot}/.env`,
      [
        "",
        "# --- SvelteKit · kiểm tra CSRF khi chạy sau reverse proxy ---------------",
        "# adapter-node CHẶN mọi POST/form action bằng 403 \"Cross-site POST form",
        "# submissions are forbidden\" nếu Origin trình duyệt gửi lên không khớp",
        "# origin server tự suy ra. Sau proxy server chỉ thấy http://127.0.0.1 nên",
        "# rất dễ lệch. PROTOCOL_HEADER + HOST_HEADER ở trên đã cho adapter dựng lại",
        `# đúng https://${domain} từ header nginx -> thường KHÔNG cần đặt gì thêm.`,
        "#",
        "# Nếu vẫn dính 403 (hoặc muốn ghim cứng origin), BỎ COMMENT dòng dưới SAU",
        "# khi đã cấp SSL (napp cert issue) — trước đó cert chưa có, đặt https sẽ sai:",
        `# ORIGIN=https://${domain}`,
        "",
      ].join("\n")
    );
    runCmd("chown", [`${user}:${user}`, `${webRoot}/.env`]);
    ok("Đã ghi cấu hình vào .env (quyền 600, chỉ user của app đọc được)");

    // --- phân quyền chuẩn ---
    runCmd("chown", ["-R", `${user}:${user}`, webRoot]);
    runCmd("find", [webRoot, "-type", "d", "-exec", "chmod", "750", "{}", "+"]);
    runCmd("find", [webRoot, "-type", "f", "-exec", "chmod", "640", "{}", "+"]);
    runCmd("chmod", ["600", `${webRoot}/.env`]);

    // --- systemd service ---
    ensureDir("/var/log/napp", 0o750);
    const record: AppRecord = {
      domain,
      aliasDomains: [],
      user,
      webRoot,
      port,
      nodeRuntime: opts.runtime,
      packageManager: pm,
      installCmd,
      buildCmd,
      startCmd,
      repoUrl: opts.repo,
      branch: opts.branch,
      dbName: dbInfo?.name,
      dbUser: dbInfo?.user,
      redisDbIndex,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const unitPath = `${SYSTEMD_DIR}/${serviceName}.service`;
    // Heap V8 chỉ đặt cho runtime node (bun dùng JSC, không hiểu cờ này). Chia
    // theo TỔNG số app SAU khi thêm app này (hiện có + 1) để cân đối RAM; user
    // có thể ghi đè NODE_OPTIONS trong .env.
    const totalAppsAfter = Object.keys(loadState().apps).length + 1;
    const nodeOptions = opts.runtime === "node" ? `--max-old-space-size=${nodeMaxOldSpaceMB(detectHardware(), totalAppsAfter)}` : undefined;
    writeFile(unitPath, renderAppSystemdService(record, execStartLine(startCmd), { nodeOptions }), 0o644);
    if (nodeOptions) info(`NODE_OPTIONS=${nodeOptions} (heap V8 chia cho ${totalAppsAfter} app; đổi trong .env nếu cần)`);
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["enable", serviceName]);
    runCmd("systemctl", ["restart", serviceName]);
    ok(`Đã tạo và khởi động systemd service '${serviceName}'`);

    // --- nginx vhost (chỉ HTTP; certbot sẽ thêm SSL sau) ---
    // Ghi map dùng chung TRƯỚC: vhost dưới đây tham chiếu $napp_connection_upgrade,
    // thiếu file này thì `nginx -t` sẽ trượt vì biến chưa được định nghĩa.
    ensureNappProxyConf();
    const ngxConf = `${NGINX_AVAILABLE}/${domain}.conf`;
    writeFile(ngxConf, renderAppNginxConf(record, { ipv6: ipv6Available() }), 0o644);
    runCmd("ln", ["-sf", ngxConf, `${NGINX_ENABLED}/${domain}.conf`]);
    const test = execCapture("nginx", ["-t"]);
    if (test.code !== 0) die(`Kiểm tra cấu hình nginx thất bại:\n${test.stderr}`);
    runCmd("systemctl", ["reload", "nginx"]);
    ok("Đã kích hoạt vhost nginx (chỉ HTTP)");

    upsertApp(record);
    rollbackActive = false;
    release();

    // Cân đối lại heap V8 giữa các app để chia sẻ RAM. App vừa tạo đã chạy với
    // heap đúng rồi nên bỏ qua restart nó; chỉ ghi lại + restart các app CŨ để
    // chúng nhường bớt heap cho app mới (quan trọng trên máy RAM nhỏ).
    const totalApps = Object.keys(loadState().apps).length;
    if (totalApps > 1) {
      const heapMB = applyNodeHeaps({ restart: true, skipRestartFor: domain });
      info(`Đã cân đối heap V8 còn ${heapMB} MB/app cho ${totalApps} app (đã restart các app cũ để áp).`);
    }

    console.log();
    console.log("===============================================================");
    ok("Tạo app thành công!");
    console.log(`  Tên miền     : http://${domain}`);
    console.log(`  Mã nguồn     : ${webRoot}`);
    console.log(`  Chạy bằng    : ${user} (systemd: ${serviceName})`);
    console.log(`  Runtime      : ${opts.runtime} · quản lý gói: ${pm}`);
    console.log(`  Cổng nội bộ  : 127.0.0.1:${port} (không public — chỉ nginx proxy vào)`);
    if (dbInfo) {
      console.log(`  Database     : ${dbInfo.name}  (user: ${dbInfo.user}@localhost, mật khẩu trong .env)`);
    }
    if (redisDbIndex !== undefined) console.log(`  Redis DB     : #${redisDbIndex}`);
    console.log();
    console.log("  Các bước tiếp theo:");
    console.log(`  1. Trỏ bản ghi DNS A của ${domain} (và www.${domain} nếu dùng) về server này.`);
    console.log(`  2. Kích hoạt SSL:  sudo napp cert issue ${domain}`);
    console.log(`  3. Xem log:        sudo napp app logs ${domain} -f`);
    console.log("  App SvelteKit dùng form action: nếu POST bị 403 CSRF, xem ghi chú ORIGIN trong .env.");
    console.log("===============================================================");
  } catch (e) {
    rollback();
    throw e;
  }
}

export async function cmdAppDeploy(domain: string): Promise<void> {
  requireRoot();
  validateDomain(domain);
  const app = requireApp(domain);
  if (!app.repoUrl) die(`App '${domain}' không có --repo liên kết — không có gì để deploy. Hãy tự cập nhật mã nguồn thủ công rồi 'napp app restart ${domain}'.`);

  const release = acquireLock(domain);
  try {
    section(`Deploy ${domain}`);
    info(`Đang git pull (${app.branch})...`);
    runAs(app.user, "git", ["fetch", "origin", app.branch], { cwd: app.webRoot });
    runAs(app.user, "git", ["reset", "--hard", `origin/${app.branch}`], { cwd: app.webRoot });

    // Đảm bảo trình quản lý gói của app dùng được ở mức hệ thống (tự cài pnpm/yarn
    // nếu thiếu) — tránh 'command not found' khi chạy installCmd dưới app user.
    if (app.packageManager) ensurePackageManager(app.packageManager);

    info("Đang cài dependencies...");
    runAs(app.user, "bash", ["-lc", app.installCmd], { cwd: app.webRoot });

    if (app.buildCmd) {
      info("Đang build...");
      runAs(app.user, "bash", ["-lc", app.buildCmd], { cwd: app.webRoot });
    }

    runCmd("chown", ["-R", `${app.user}:${app.user}`, app.webRoot]);
    runCmd("chmod", ["600", `${app.webRoot}/.env`], { silentFail: true });

    runCmd("systemctl", ["restart", serviceNameFor(domain)]);
    app.updatedAt = new Date().toISOString();
    upsertApp(app);
    ok(`Deploy hoàn tất — đã khởi động lại ${serviceNameFor(domain)}`);
  } finally {
    release();
  }
}

// Những tài nguyên có thể chọn xoá khi gỡ app. `service` (systemd) LUÔN bị gỡ vì
// app rời khỏi registry thì napp không quản lý được service nữa — nên nó không
// nằm trong lựa chọn. Mặc định: xoá nginx + ssl (an toàn, dễ tạo lại), GIỮ mã
// nguồn + database (dữ liệu quý, xoá nhầm là mất trắng) trừ khi người dùng chọn.
export interface AppRemoveOptions {
  yes: boolean;
  nginx: boolean; // xoá cấu hình vhost nginx + reload
  ssl: boolean; // xoá chứng chỉ SSL (certbot delete)
  source: boolean; // xoá mã nguồn + user hệ thống của app
  database: boolean; // xoá database + user CSDL
}

// Xoá chứng chỉ SSL của domain — best-effort, không bao giờ chặn phần gỡ còn lại.
// Dùng `certbot delete` (chỉ xoá file cert + cấu hình gia hạn ở LOCAL, không gọi
// mạng tới Let's Encrypt như `revoke`) — hợp với ngữ cảnh gỡ app: nhanh, không
// treo, không phụ thuộc mạng. certbot đặt tên cert theo domain chính (-d đầu tiên
// lúc phát hành) nên `--cert-name <domain>` là đúng.
function removeCert(domain: string): void {
  if (!commandExists("certbot")) {
    info("certbot không có sẵn — bỏ qua xoá chứng chỉ SSL.");
    return;
  }
  const res = execCapture("certbot", ["delete", "--cert-name", domain, "--non-interactive"]);
  if (res.code === 0) ok(`Đã xoá chứng chỉ SSL của '${domain}'.`);
  else info(`Không có chứng chỉ SSL tên '${domain}' để xoá (hoặc đã xoá trước đó).`);
}

export async function cmdAppRemove(domain: string, opts: AppRemoveOptions): Promise<void> {
  requireRoot();
  validateDomain(domain);
  const app = requireApp(domain);

  // Cảnh báo các tổ hợp lệch trước khi làm gì:
  // - Xoá cert nhưng GIỮ vhost nginx: vhost trỏ tới file cert không còn tồn tại
  //   -> lần `nginx -t`/reload sau sẽ trượt.
  if (opts.ssl && !opts.nginx) {
    warn("Bạn chọn xoá SSL nhưng giữ cấu hình nginx — vhost sẽ trỏ tới chứng chỉ đã xoá và lần reload nginx sau có thể trượt. Cân nhắc xoá luôn cấu hình nginx.");
  }
  // - Giữ vhost nginx nhưng service systemd LUÔN bị gỡ: vhost vẫn proxy vào
  //   127.0.0.1:port nhưng không còn tiến trình nào lắng nghe -> site trả 502.
  if (!opts.nginx) {
    warn(`Bạn chọn giữ cấu hình nginx, nhưng service systemd luôn bị gỡ — '${domain}' sẽ trả 502 (không còn tiến trình lắng nghe ở cổng ${app.port}) cho tới khi bạn dựng lại backend.`);
  }
  // - Xoá mã nguồn nhưng GIỮ database: mật khẩu DB chỉ nằm trong .env (không lưu
  //   ở state.json), xoá mã nguồn là xoá .env -> giữ được DATA nhưng MẤT credential.
  //   Data còn nguyên, chỉ là phải reset mật khẩu bằng root mới truy cập lại được.
  if (opts.source && !opts.database && app.dbName) {
    warn(
      `Bạn chọn xoá mã nguồn nhưng giữ database '${app.dbName}' — mật khẩu DB chỉ lưu trong .env (nằm trong mã nguồn), xoá đi là MẤT. ` +
        `Database và dữ liệu vẫn còn, nhưng muốn dùng lại phải đặt mật khẩu mới: ALTER USER '${app.dbUser ?? app.dbName}'@'localhost' IDENTIFIED BY '<mật khẩu mới>'. ` +
        `Hãy sao chép .env (hoặc dòng DB_PASSWORD) ra nơi khác trước nếu cần.`
    );
  }

  // Danh sách những gì sẽ bị xoá — hiển thị để người dùng xác nhận có chủ đích.
  const willDelete = [
    `service systemd (${serviceNameFor(domain)})`,
    ...(opts.nginx ? [`cấu hình nginx (${domain}.conf)`] : []),
    ...(opts.ssl ? ["chứng chỉ SSL"] : []),
    ...(opts.source ? [`mã nguồn (${app.webRoot}) + user hệ thống '${app.user}'`] : []),
    ...(opts.database && app.dbName ? [`database '${app.dbName}'`] : []),
  ];
  const willKeep = [
    ...(!opts.nginx ? ["cấu hình nginx"] : []),
    ...(!opts.source ? [`mã nguồn (${app.webRoot})`] : []),
    ...(!opts.database && app.dbName ? [`database '${app.dbName}'`] : []),
  ];

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(
      `Thao tác này sẽ gỡ app '${domain}' khỏi napp và XOÁ:\n` +
        willDelete.map((w) => `  - ${w}`).join("\n") +
        (willKeep.length ? `\nGIỮ lại:\n` + willKeep.map((w) => `  - ${w}`).join("\n") : "") +
        `\nTiếp tục? [y/N] `
    );
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  const release = acquireLock(domain);
  try {
    // --- service systemd: LUÔN gỡ (app rời registry -> không quản lý được nữa) ---
    const serviceName = serviceNameFor(domain);
    runCmd("systemctl", ["stop", serviceName], { silentFail: true });
    runCmd("systemctl", ["disable", serviceName], { silentFail: true });
    runCmd("rm", ["-f", `${SYSTEMD_DIR}/${serviceName}.service`], { silentFail: true });
    runCmd("systemctl", ["daemon-reload"], { silentFail: true });

    // --- SSL: xoá cert TRƯỚC khi đụng nginx (nếu cùng xoá cả hai) ---
    if (opts.ssl) removeCert(domain);

    // --- nginx vhost ---
    if (opts.nginx) {
      runCmd("rm", ["-f", `${NGINX_ENABLED}/${domain}.conf`, `${NGINX_AVAILABLE}/${domain}.conf`], { silentFail: true });
      runCmd("bash", ["-lc", "nginx -t >/dev/null 2>&1 && systemctl reload nginx || true"], { silentFail: true });
      ok(`Đã xoá cấu hình nginx của '${domain}'.`);
    } else {
      info("Giữ lại cấu hình nginx.");
    }

    // --- mã nguồn + user hệ thống (đi kèm nhau: user chỉ để chạy app này) ---
    if (opts.source) {
      if (existsSync(app.webRoot)) {
        try {
          rmSync(app.webRoot, { recursive: true, force: true });
          ok(`Đã xoá mã nguồn ${app.webRoot}.`);
        } catch (e) {
          warn(`Không xoá được thư mục mã nguồn ${app.webRoot} (${(e as Error).message}) — hãy tự xoá sau.`);
        }
      }
      if (execCapture("id", [app.user]).code === 0) {
        runCmd("userdel", ["-r", app.user], { silentFail: true });
        ok(`Đã xoá user hệ thống '${app.user}'.`);
      }
    } else {
      info(`Giữ lại mã nguồn ${app.webRoot} và user hệ thống '${app.user}'.`);
    }

    // --- database ---
    if (opts.database) {
      if (app.dbName) {
        try {
          dropDatabase(app.dbName, app.dbUser);
          ok(`Đã xoá database '${app.dbName}'.`);
        } catch (e) {
          warn(
            `Không xoá được database '${app.dbName}' (${(e as Error).message}). ` +
              `Các tài nguyên khác đã xử lý xong — hãy tự xoá database này sau bằng 'napp db drop ${app.dbName} --yes --user ${app.dbUser ?? app.dbName}'.`
          );
        }
      } else {
        info("App không có database riêng — bỏ qua.");
      }
    } else if (app.dbName) {
      info(`Giữ lại database '${app.dbName}'. Muốn xoá sau: napp db drop ${app.dbName} --yes --user ${app.dbUser ?? app.dbName}`);
    }

    removeAppFromState(domain);
    ok(`Đã gỡ app '${domain}' khỏi napp.`);

    // Cân đối lại heap V8 cho các app còn lại — nay được chia phần RAM lớn hơn.
    const remaining = Object.keys(loadState().apps).length;
    if (remaining > 0) {
      const heapMB = applyNodeHeaps({ restart: true });
      info(`Đã cân đối lại heap V8 lên ${heapMB} MB/app cho ${remaining} app còn lại.`);
    }
  } finally {
    release();
  }
}

export interface AppSummary {
  domain: string;
  port: number;
  running: boolean;
}

// Danh sách app kèm trạng thái chạy — dùng cho menu tương tác để người dùng
// CHỌN app từ danh sách thay vì gõ tay domain.
export function listAppSummaries(): AppSummary[] {
  return Object.values(loadState().apps)
    .map((a) => ({
      domain: a.domain,
      port: a.port,
      running: execCapture("systemctl", ["is-active", "--quiet", serviceNameFor(a.domain)]).code === 0,
    }))
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

export function cmdAppList(): void {
  const s = loadState();
  const apps = Object.values(s.apps);
  if (apps.length === 0) {
    info("Chưa có app nào được napp quản lý. Dùng 'napp app create <domain> ...' để tạo mới.");
    return;
  }
  section(`Danh sách app (${apps.length})`);
  for (const app of apps) {
    const running = execCapture("systemctl", ["is-active", "--quiet", serviceNameFor(app.domain)]).code === 0;
    console.log(
      `  ${running ? "●" : "○"} ${app.domain.padEnd(30)} port=${String(app.port).padEnd(6)} ${`${app.nodeRuntime}/${app.packageManager ?? "npm"}`.padEnd(10)} user=${app.user.padEnd(18)} ${
        app.dbName ? `db=${app.dbName} ` : ""
      }${app.redisDbIndex !== undefined ? `redis=${app.redisDbIndex} ` : ""}${running ? "đang chạy" : "ĐÃ DỪNG"}`
    );
  }
}

export function cmdAppRestart(domain: string): void {
  requireRoot();
  validateDomain(domain);
  requireApp(domain);
  runCmd("systemctl", ["restart", serviceNameFor(domain)]);
  ok(`Đã khởi động lại ${serviceNameFor(domain)}`);
}

export function cmdAppStop(domain: string): void {
  requireRoot();
  validateDomain(domain);
  requireApp(domain);
  runCmd("systemctl", ["stop", serviceNameFor(domain)]);
  ok(`Đã dừng ${serviceNameFor(domain)}`);
}

export function cmdAppStart(domain: string): void {
  requireRoot();
  validateDomain(domain);
  requireApp(domain);
  runCmd("systemctl", ["start", serviceNameFor(domain)]);
  ok(`Đã khởi động ${serviceNameFor(domain)}`);
}

export function cmdAppLogs(domain: string, opts: { follow: boolean; lines: number }): void {
  validateDomain(domain);
  requireApp(domain);
  const args = ["-u", serviceNameFor(domain), "-n", String(opts.lines), "--no-pager"];
  if (opts.follow) args.push("-f");
  runCmd("journalctl", args);
}

export function cmdAppEnvSet(domain: string, pairs: string[]): void {
  requireRoot();
  validateDomain(domain);
  const app = requireApp(domain);
  const updates: Record<string, string> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf("=");
    if (eq === -1) die(`Tham số phải theo dạng KEY=VALUE, nhận được: '${kv}'`);
    const key = kv.slice(0, eq);
    validateEnvKey(key);
    updates[key] = kv.slice(eq + 1);
  }
  mergeEnvFile(`${app.webRoot}/.env`, updates, 0o600);
  runCmd("chown", [`${app.user}:${app.user}`, `${app.webRoot}/.env`]);
  runCmd("chmod", ["600", `${app.webRoot}/.env`]);
  ok(`Đã cập nhật .env cho '${domain}'. Chạy 'napp app restart ${domain}' để áp dụng.`);
}

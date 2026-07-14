import { existsSync, rmSync } from "node:fs";
import { execCapture, runCmd, runAs, ensureDir, requireRoot, commandExists } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { validateDomain, validatePort, validateRepoUrl, validateBranch, validateEnvKey } from "../lib/validate";
import {
  AppRecord,
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
import { renderAppSystemdService, execStartLine } from "../templates/systemd";
import { ipv6Available } from "../lib/network";

export interface CreateAppOptions {
  port?: number;
  repo?: string;
  branch: string;
  runtime: "node" | "bun";
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  db: boolean;
  redis: boolean;
  env: string[]; // "KEY=VALUE"
}

function defaultInstallCmd(runtime: "node" | "bun"): string {
  return runtime === "bun" ? "bun install --production" : "npm ci --omit=dev || npm install --omit=dev";
}

function defaultStartCmd(runtime: "node" | "bun"): string {
  return runtime === "bun" ? "bun run start" : "npm start";
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

  if (!commandExists("node") && opts.runtime === "node") {
    die("Node.js chưa được cài. Chạy 'napp check --fix' trước.");
  }
  if (opts.runtime === "bun" && !commandExists("bun")) {
    warn("Không tìm thấy lệnh 'bun' trong PATH của root — hãy đảm bảo bun đã được cài toàn cục (curl -fsSL https://bun.sh/install | bash rồi ln -s vào /usr/local/bin).");
  }
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
    info(`Runtime ${opts.runtime}, cổng ${port}, user hệ thống ${user}`);

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

    const installCmd = opts.installCmd ?? defaultInstallCmd(opts.runtime);
    const buildCmd = opts.buildCmd ?? "";
    const startCmd = opts.startCmd ?? defaultStartCmd(opts.runtime);

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
    const { writeFile } = await import("../lib/exec");
    writeFile(unitPath, renderAppSystemdService(record, execStartLine(startCmd)), 0o644);
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["enable", serviceName]);
    runCmd("systemctl", ["restart", serviceName]);
    ok(`Đã tạo và khởi động systemd service '${serviceName}'`);

    // --- nginx vhost (chỉ HTTP; certbot sẽ thêm SSL sau) ---
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

    console.log();
    console.log("===============================================================");
    ok("Tạo app thành công!");
    console.log(`  Tên miền     : http://${domain}`);
    console.log(`  Mã nguồn     : ${webRoot}`);
    console.log(`  Chạy bằng    : ${user} (systemd: ${serviceName})`);
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

export async function cmdAppRemove(domain: string, opts: { yes: boolean; keepDb: boolean }): Promise<void> {
  requireRoot();
  validateDomain(domain);
  const app = requireApp(domain);

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(
      `Thao tác này sẽ XOÁ app '${domain}': service, nginx vhost, user hệ thống, mã nguồn tại ${app.webRoot}` +
        (app.dbName && !opts.keepDb ? `, và database '${app.dbName}'` : "") +
        `.\nTiếp tục? [y/N] `
    );
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  const release = acquireLock(domain);
  try {
    const serviceName = serviceNameFor(domain);
    runCmd("systemctl", ["stop", serviceName], { silentFail: true });
    runCmd("systemctl", ["disable", serviceName], { silentFail: true });
    runCmd("rm", ["-f", `${SYSTEMD_DIR}/${serviceName}.service`], { silentFail: true });
    runCmd("systemctl", ["daemon-reload"], { silentFail: true });

    runCmd("rm", ["-f", `${NGINX_ENABLED}/${domain}.conf`, `${NGINX_AVAILABLE}/${domain}.conf`], { silentFail: true });
    runCmd("bash", ["-lc", "nginx -t >/dev/null 2>&1 && systemctl reload nginx || true"], { silentFail: true });

    if (existsSync(app.webRoot)) {
      try {
        rmSync(app.webRoot, { recursive: true, force: true });
      } catch (e) {
        warn(`Không xoá được thư mục mã nguồn ${app.webRoot} (${(e as Error).message}) — hãy tự xoá sau.`);
      }
    }

    if (execCapture("id", [app.user]).code === 0) {
      runCmd("userdel", ["-r", app.user], { silentFail: true });
    }

    if (app.dbName && !opts.keepDb) {
      try {
        dropDatabase(app.dbName, app.dbUser);
        ok(`Đã xoá database '${app.dbName}'`);
      } catch (e) {
        warn(
          `Không xoá được database '${app.dbName}' (${(e as Error).message}). ` +
            `Các tài nguyên khác của app đã bị xoá — hãy tự xoá database này sau bằng 'napp db drop ${app.dbName} --yes --user ${app.dbUser ?? app.dbName}'.`
        );
      }
    }

    removeAppFromState(domain);
    ok(`Đã xoá app '${domain}'.`);
  } finally {
    release();
  }
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
      `  ${running ? "●" : "○"} ${app.domain.padEnd(30)} port=${String(app.port).padEnd(6)} user=${app.user.padEnd(18)} ${
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

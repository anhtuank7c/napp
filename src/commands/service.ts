import { existsSync, rmSync } from "node:fs";
import { execCapture, runCmd, runAs, ensureDir, requireRoot, writeFile } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { validateServiceName, validatePort, validateRepoUrl, validateBranch, validateEnvKey } from "../lib/validate";
import {
  ServiceRecord,
  Runtime,
  PackageManager,
  getService,
  requireService,
  upsertService,
  removeService as removeServiceFromState,
  allocatePort,
  allocateRedisDb,
  serviceUserFor,
  svcSystemdName,
  SERVICE_ROOT,
  SYSTEMD_DIR,
  loadState,
} from "../lib/state";
import { acquireLock } from "../lib/lock";
import { createDatabase, dropDatabase } from "../lib/mysql";
import { mergeEnvFile } from "../lib/envfile";
import { renderServiceSystemdService, execStartLine } from "../templates/systemd";
import { detectHardware } from "../lib/hardware";
import { nodeMaxOldSpaceMB } from "../templates/tuning";
import { GIT_NONINTERACTIVE_ENV, prepareRepoAuth, setupRepoAuth } from "../lib/repo";
import { defaultPackageManager, defaultInstallCmd, defaultStartCmd, ensurePackageManager, ensureRuntime } from "../lib/provision";
import { applyNodeHeaps } from "./app";

export interface CreateServiceOptions {
  port?: number; // KHÔNG cấp cổng trừ khi truyền — service thuần worker không listen gì
  repo?: string;
  branch: string;
  runtime: Runtime;
  packageManager?: PackageManager;
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  db: boolean;
  redis: boolean;
  env: string[]; // "KEY=VALUE"
  token?: string; // PAT clone repo PRIVATE qua HTTPS
  sshKey?: string; // deploy key clone repo PRIVATE qua SSH
}

function serviceExists(name: string): boolean {
  return getService(name) !== undefined;
}

function assertServiceAbsent(name: string, user: string): void {
  const conflicts: string[] = [];
  const workDir = `${SERVICE_ROOT}/${name}`;
  if (existsSync(workDir)) conflicts.push(`thư mục mã nguồn: ${workDir}`);
  const unit = `${SYSTEMD_DIR}/${svcSystemdName(name)}.service`;
  if (existsSync(unit)) conflicts.push(`systemd unit: ${unit}`);
  if (execCapture("id", [user]).code === 0) conflicts.push(`user hệ thống: ${user}`);
  if (serviceExists(name)) conflicts.push(`registry: đã có service '${name}' trong /etc/napp/state.json`);

  if (conflicts.length > 0) {
    die(
      `Background service '${name}' (hoặc tài nguyên cùng tên) ĐÃ TỒN TẠI — không tạo trùng.\n` +
        conflicts.map((c) => `  - ${c}`).join("\n") +
        `\n  Muốn tạo lại? Hãy xoá trước bằng: napp service remove ${name}`
    );
  }
}

export async function cmdServiceCreate(name: string, opts: CreateServiceOptions): Promise<void> {
  requireRoot();
  validateServiceName(name);
  validateBranch(opts.branch);
  if (opts.repo) validateRepoUrl(opts.repo);

  // Fail sớm cho xác thực repo private; --ssh-key được resolve thành nội dung key.
  prepareRepoAuth(opts);

  const user = serviceUserFor(name);
  const workDir = `${SERVICE_ROOT}/${name}`;
  // Cổng LÀ TUỲ CHỌN cho background service. Chỉ cấp (và ép Environment=PORT) khi
  // người dùng truyền --port; worker thuần không listen gì thì không cần cổng.
  const port = opts.port !== undefined ? allocatePort(opts.port) : undefined;
  if (port !== undefined) validatePort(port);
  const unitName = svcSystemdName(name);

  assertServiceAbsent(name, user);

  const pm: PackageManager = opts.packageManager ?? defaultPackageManager(opts.runtime);

  ensureRuntime(opts.runtime);
  // Trình quản lý gói phải dùng được Ở MỨC HỆ THỐNG (user service + systemd đều thấy).
  ensurePackageManager(pm);

  const release = acquireLock(name);
  let rollbackActive = true;
  let dbCreatedName: string | undefined;
  const rollback = () => {
    if (!rollbackActive) return;
    warn("Tạo service thất bại — đang hoàn tác các thay đổi đã thực hiện...");
    try {
      runCmd("systemctl", ["stop", unitName], { silentFail: true });
      runCmd("systemctl", ["disable", unitName], { silentFail: true });
      runCmd("rm", ["-f", `${SYSTEMD_DIR}/${unitName}.service`], { silentFail: true });
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
      if (execCapture("id", [user]).code === 0) {
        runCmd("userdel", ["-r", user], { silentFail: true });
      }
      if (dbCreatedName) {
        try {
          dropDatabase(dbCreatedName, dbCreatedName);
        } catch {
          /* đã cảnh báo bên trong; không chặn phần rollback còn lại */
        }
      }
      warn(`Đã hoàn tác. Hệ thống trở lại trạng thái trước khi tạo service '${name}'.`);
    } finally {
      release();
    }
  };

  try {
    section(`Tạo background service ${name}`);
    info(`Runtime ${opts.runtime}, quản lý gói ${pm}, user hệ thống ${user}${port !== undefined ? `, cổng ${port}` : " (không cổng)"}`);

    // --- user hệ thống riêng, cô lập với các app/service khác ---
    runCmd("useradd", ["--system", "--create-home", "--home-dir", `/home/${user}`, "--shell", "/usr/sbin/nologin", user]);
    ok(`Đã tạo user hệ thống ${user}`);

    // --- thư mục mã nguồn ---
    ensureDir(workDir);
    runCmd("chown", [`${user}:${user}`, workDir]);

    if (opts.repo) {
      if (opts.token || opts.sshKey) setupRepoAuth(user, opts.repo, opts);
      info(`Đang clone ${opts.repo} (branch ${opts.branch})...`);
      const clone = runAs(user, "git", ["clone", "--branch", opts.branch, "--depth", "1", opts.repo, workDir], {
        env: GIT_NONINTERACTIVE_ENV,
        silentFail: true,
      });
      if (clone.code !== 0) {
        const privateHint =
          !opts.token && !opts.sshKey
            ? `\n  Nếu đây là repo PRIVATE: napp KHÔNG hỏi mật khẩu tương tác (tránh treo). Hãy thêm:\n` +
              `    - Repo HTTPS: --token <Personal-Access-Token>\n` +
              `    - Repo SSH  : --ssh-key <đường-dẫn-deploy-key>`
            : `\n  Kiểm tra lại token/deploy key có quyền đọc repo, và branch '${opts.branch}' tồn tại.`;
        die(`Clone repo thất bại (mã ${clone.code}). Kiểm tra URL/branch, mạng, hoặc quyền truy cập.${privateHint}`);
      }
    } else {
      info("Không có --repo — tạo worker mẫu tối giản để bạn tự đưa mã nguồn lên sau...");
      runAs(user, "bash", [
        "-lc",
        `cat > ${JSON.stringify(workDir + "/package.json")} <<'EOF'
{
  "name": "${name.replace(/[^a-z0-9-]/gi, "-")}",
  "version": "1.0.0",
  "private": true,
  "scripts": { "start": "node worker.js" }
}
EOF
cat > ${JSON.stringify(workDir + "/worker.js")} <<'EOF'
// File tạm do napp tạo — hãy thay bằng mã nguồn thật của background service.
// Đây là một tiến trình chạy NGẦM (không HTTP, không domain). systemd sẽ tự
// khởi động lại nếu tiến trình thoát. In heartbeat để 'napp service logs' thấy.
const started = new Date().toISOString();
console.log("[napp] background service '${name}' đã khởi động lúc " + started);
setInterval(() => {
  console.log("[napp] heartbeat " + new Date().toISOString());
}, 60000);
// Giữ tiến trình sống; thay bằng vòng lặp xử lý công việc thật của bạn.
process.on("SIGTERM", () => { console.log("[napp] nhận SIGTERM — thoát."); process.exit(0); });
EOF`,
      ]);
    }

    const installCmd = opts.installCmd ?? defaultInstallCmd(pm);
    const buildCmd = opts.buildCmd ?? "";
    const startCmd = opts.startCmd ?? defaultStartCmd(opts.runtime, pm);

    if (existsSync(`${workDir}/package.json`) || opts.repo) {
      info("Đang cài dependencies...");
      runAs(user, "bash", ["-lc", installCmd], { cwd: workDir });
      if (buildCmd) {
        info("Đang build...");
        runAs(user, "bash", ["-lc", buildCmd], { cwd: workDir });
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
        warn("Đã hết database Redis riêng (0-15). Bỏ qua cấp DB riêng — hãy dùng key-prefix trong service thay vì DB riêng.");
      } else {
        ok(`Đã cấp Redis DB #${redisDbIndex} cho service này`);
      }
    }

    // --- .env ---
    // KHÁC web app: service không chạy sau reverse proxy nên KHÔNG có APP_URL/
    // PROTOCOL_HEADER/HOST_HEADER/XFF_DEPTH (những biến chỉ có nghĩa sau nginx).
    // Chỉ ghi NODE_ENV, PORT (nếu có), thông tin DB/Redis, và biến người dùng thêm.
    const envUpdates: Record<string, string> = { NODE_ENV: "production" };
    if (port !== undefined) envUpdates.PORT = String(port);
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
    mergeEnvFile(`${workDir}/.env`, envUpdates, 0o600);
    runCmd("chown", [`${user}:${user}`, `${workDir}/.env`]);
    ok("Đã ghi cấu hình vào .env (quyền 600, chỉ user của service đọc được)");

    // --- phân quyền chuẩn ---
    runCmd("chown", ["-R", `${user}:${user}`, workDir]);
    runCmd("find", [workDir, "-type", "d", "-exec", "chmod", "750", "{}", "+"]);
    runCmd("find", [workDir, "-type", "f", "-exec", "chmod", "640", "{}", "+"]);
    runCmd("chmod", ["600", `${workDir}/.env`]);

    // --- systemd service ---
    ensureDir("/var/log/napp", 0o750);
    const record: ServiceRecord = {
      name,
      user,
      workDir,
      nodeRuntime: opts.runtime,
      packageManager: pm,
      installCmd,
      buildCmd,
      startCmd,
      port,
      repoUrl: opts.repo,
      branch: opts.branch,
      dbName: dbInfo?.name,
      dbUser: dbInfo?.user,
      redisDbIndex,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const unitPath = `${SYSTEMD_DIR}/${unitName}.service`;
    // Heap V8 chỉ đặt cho runtime node. Chia theo TỔNG số đơn vị node (app + service)
    // SAU khi thêm service này để cân đối RAM; user có thể ghi đè NODE_OPTIONS trong .env.
    const st = loadState();
    const totalUnitsAfter = Object.keys(st.apps).length + Object.keys(st.services).length + 1;
    const nodeOptions = opts.runtime === "node" ? `--max-old-space-size=${nodeMaxOldSpaceMB(detectHardware(), totalUnitsAfter)}` : undefined;
    writeFile(unitPath, renderServiceSystemdService(record, execStartLine(startCmd), { nodeOptions }), 0o644);
    if (nodeOptions) info(`NODE_OPTIONS=${nodeOptions} (heap V8 chia cho ${totalUnitsAfter} đơn vị node; đổi trong .env nếu cần)`);
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["enable", unitName]);
    runCmd("systemctl", ["restart", unitName]);
    ok(`Đã tạo và khởi động systemd service '${unitName}'`);

    upsertService(record);
    rollbackActive = false;
    release();

    // Cân đối lại heap V8 giữa các đơn vị node còn lại (service vừa tạo đã chạy
    // với heap đúng nên bỏ qua restart nó).
    const totalUnits = Object.keys(loadState().apps).length + Object.keys(loadState().services).length;
    if (totalUnits > 1) {
      const heapMB = applyNodeHeaps({ restart: true, skipRestartFor: name });
      info(`Đã cân đối heap V8 còn ${heapMB} MB/đơn vị cho ${totalUnits} đơn vị node (đã restart các đơn vị cũ để áp).`);
    }

    console.log();
    console.log("===============================================================");
    ok("Tạo background service thành công!");
    console.log(`  Tên service  : ${name}`);
    console.log(`  Mã nguồn     : ${workDir}`);
    console.log(`  Chạy bằng    : ${user} (systemd: ${unitName})`);
    console.log(`  Runtime      : ${opts.runtime} · quản lý gói: ${pm}`);
    if (port !== undefined) console.log(`  Cổng nội bộ  : 127.0.0.1:${port} (service tự bind — KHÔNG public qua nginx)`);
    else console.log(`  Cổng         : không cấp (worker chạy ngầm, không listen)`);
    if (dbInfo) console.log(`  Database     : ${dbInfo.name}  (user: ${dbInfo.user}@localhost, mật khẩu trong .env)`);
    if (redisDbIndex !== undefined) console.log(`  Redis DB     : #${redisDbIndex}`);
    console.log();
    console.log("  Các bước tiếp theo:");
    console.log(`  1. Xem log:      sudo napp service logs ${name} -f`);
    console.log(`  2. Deploy bản mới (nếu có --repo): sudo napp service deploy ${name}`);
    console.log("===============================================================");
  } catch (e) {
    rollback();
    throw e;
  }
}

export async function cmdServiceDeploy(name: string): Promise<void> {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);
  if (!svc.repoUrl) die(`Service '${name}' không có --repo liên kết — không có gì để deploy. Hãy tự cập nhật mã nguồn thủ công rồi 'napp service restart ${name}'.`);

  const release = acquireLock(name);
  try {
    section(`Deploy service ${name}`);
    info(`Đang git pull (${svc.branch})...`);
    // Cùng env KHÔNG TƯƠNG TÁC như lúc clone: repo private dùng lại token/deploy key.
    runAs(svc.user, "git", ["fetch", "origin", svc.branch], { cwd: svc.workDir, env: GIT_NONINTERACTIVE_ENV });
    runAs(svc.user, "git", ["reset", "--hard", `origin/${svc.branch}`], { cwd: svc.workDir, env: GIT_NONINTERACTIVE_ENV });

    if (svc.packageManager) ensurePackageManager(svc.packageManager);

    info("Đang cài dependencies...");
    runAs(svc.user, "bash", ["-lc", svc.installCmd], { cwd: svc.workDir });

    if (svc.buildCmd) {
      info("Đang build...");
      runAs(svc.user, "bash", ["-lc", svc.buildCmd], { cwd: svc.workDir });
    }

    runCmd("chown", ["-R", `${svc.user}:${svc.user}`, svc.workDir]);
    runCmd("chmod", ["600", `${svc.workDir}/.env`], { silentFail: true });

    runCmd("systemctl", ["restart", svcSystemdName(name)]);
    svc.updatedAt = new Date().toISOString();
    upsertService(svc);
    ok(`Deploy hoàn tất — đã khởi động lại ${svcSystemdName(name)}`);
  } finally {
    release();
  }
}

export interface ServiceRemoveOptions {
  yes: boolean;
  source: boolean; // xoá mã nguồn + user hệ thống
  database: boolean; // xoá database + user CSDL
}

export async function cmdServiceRemove(name: string, opts: ServiceRemoveOptions): Promise<void> {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);

  if (opts.source && !opts.database && svc.dbName) {
    warn(
      `Bạn chọn xoá mã nguồn nhưng giữ database '${svc.dbName}' — mật khẩu DB chỉ lưu trong .env (nằm trong mã nguồn), xoá đi là MẤT. ` +
        `Database và dữ liệu vẫn còn, nhưng muốn dùng lại phải đặt mật khẩu mới. Hãy sao chép .env ra nơi khác trước nếu cần.`
    );
  }

  const willDelete = [
    `service systemd (${svcSystemdName(name)})`,
    ...(opts.source ? [`mã nguồn (${svc.workDir}) + user hệ thống '${svc.user}'`] : []),
    ...(opts.database && svc.dbName ? [`database '${svc.dbName}'`] : []),
  ];
  const willKeep = [
    ...(!opts.source ? [`mã nguồn (${svc.workDir})`] : []),
    ...(!opts.database && svc.dbName ? [`database '${svc.dbName}'`] : []),
  ];

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(
      `Thao tác này sẽ gỡ service '${name}' khỏi napp và XOÁ:\n` +
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

  const release = acquireLock(name);
  try {
    const unitName = svcSystemdName(name);
    runCmd("systemctl", ["stop", unitName], { silentFail: true });
    runCmd("systemctl", ["disable", unitName], { silentFail: true });
    runCmd("rm", ["-f", `${SYSTEMD_DIR}/${unitName}.service`], { silentFail: true });
    runCmd("systemctl", ["daemon-reload"], { silentFail: true });

    if (opts.source) {
      if (existsSync(svc.workDir)) {
        try {
          rmSync(svc.workDir, { recursive: true, force: true });
          ok(`Đã xoá mã nguồn ${svc.workDir}.`);
        } catch (e) {
          warn(`Không xoá được thư mục mã nguồn ${svc.workDir} (${(e as Error).message}) — hãy tự xoá sau.`);
        }
      }
      if (execCapture("id", [svc.user]).code === 0) {
        runCmd("userdel", ["-r", svc.user], { silentFail: true });
        ok(`Đã xoá user hệ thống '${svc.user}'.`);
      }
    } else {
      info(`Giữ lại mã nguồn ${svc.workDir} và user hệ thống '${svc.user}'.`);
    }

    if (opts.database) {
      if (svc.dbName) {
        try {
          dropDatabase(svc.dbName, svc.dbUser);
          ok(`Đã xoá database '${svc.dbName}'.`);
        } catch (e) {
          warn(`Không xoá được database '${svc.dbName}' (${(e as Error).message}). Hãy tự xoá sau bằng 'napp db drop ${svc.dbName} --yes --user ${svc.dbUser ?? svc.dbName}'.`);
        }
      } else {
        info("Service không có database riêng — bỏ qua.");
      }
    } else if (svc.dbName) {
      info(`Giữ lại database '${svc.dbName}'. Muốn xoá sau: napp db drop ${svc.dbName} --yes --user ${svc.dbUser ?? svc.dbName}`);
    }

    removeServiceFromState(name);
    ok(`Đã gỡ service '${name}' khỏi napp.`);

    // Cân đối lại heap V8 cho các đơn vị node còn lại — nay được chia phần RAM lớn hơn.
    const remaining = Object.keys(loadState().apps).length + Object.keys(loadState().services).length;
    if (remaining > 0) {
      const heapMB = applyNodeHeaps({ restart: true });
      info(`Đã cân đối lại heap V8 lên ${heapMB} MB/đơn vị cho ${remaining} đơn vị node còn lại.`);
    }
  } finally {
    release();
  }
}

export interface ServiceSummary {
  name: string;
  port?: number;
  running: boolean;
}

// Danh sách service kèm trạng thái chạy — dùng cho menu tương tác.
export function listServiceSummaries(): ServiceSummary[] {
  return Object.values(loadState().services)
    .map((s) => ({
      name: s.name,
      port: s.port,
      running: execCapture("systemctl", ["is-active", "--quiet", svcSystemdName(s.name)]).code === 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function cmdServiceList(): void {
  const services = Object.values(loadState().services);
  if (services.length === 0) {
    info("Chưa có background service nào được napp quản lý. Dùng 'napp service create <name> ...' để tạo mới.");
    return;
  }
  section(`Danh sách background service (${services.length})`);
  for (const svc of services) {
    const running = execCapture("systemctl", ["is-active", "--quiet", svcSystemdName(svc.name)]).code === 0;
    console.log(
      `  ${running ? "●" : "○"} ${svc.name.padEnd(30)} ${svc.port !== undefined ? `port=${String(svc.port).padEnd(6)}` : "no-port".padEnd(11)} ${`${svc.nodeRuntime}/${svc.packageManager ?? "npm"}`.padEnd(10)} user=${svc.user.padEnd(18)} ${
        svc.dbName ? `db=${svc.dbName} ` : ""
      }${svc.redisDbIndex !== undefined ? `redis=${svc.redisDbIndex} ` : ""}${running ? "đang chạy" : "ĐÃ DỪNG"}`
    );
  }
}

export function cmdServiceRestart(name: string): void {
  requireRoot();
  validateServiceName(name);
  requireService(name);
  runCmd("systemctl", ["restart", svcSystemdName(name)]);
  ok(`Đã khởi động lại ${svcSystemdName(name)}`);
}

export function cmdServiceStop(name: string): void {
  requireRoot();
  validateServiceName(name);
  requireService(name);
  runCmd("systemctl", ["stop", svcSystemdName(name)]);
  ok(`Đã dừng ${svcSystemdName(name)}`);
}

export function cmdServiceStart(name: string): void {
  requireRoot();
  validateServiceName(name);
  requireService(name);
  runCmd("systemctl", ["start", svcSystemdName(name)]);
  ok(`Đã khởi động ${svcSystemdName(name)}`);
}

export function cmdServiceLogs(name: string, opts: { follow: boolean; lines: number }): void {
  validateServiceName(name);
  requireService(name);
  const args = ["-u", svcSystemdName(name), "-n", String(opts.lines), "--no-pager"];
  if (opts.follow) args.push("-f");
  runCmd("journalctl", args);
}

export function cmdServiceEnvSet(name: string, pairs: string[]): void {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);
  const updates: Record<string, string> = {};
  for (const kv of pairs) {
    const eq = kv.indexOf("=");
    if (eq === -1) die(`Tham số phải theo dạng KEY=VALUE, nhận được: '${kv}'`);
    const key = kv.slice(0, eq);
    validateEnvKey(key);
    updates[key] = kv.slice(eq + 1);
  }
  mergeEnvFile(`${svc.workDir}/.env`, updates, 0o600);
  runCmd("chown", [`${svc.user}:${svc.user}`, `${svc.workDir}/.env`]);
  runCmd("chmod", ["600", `${svc.workDir}/.env`]);
  ok(`Đã cập nhật .env cho service '${name}'. Chạy 'napp service restart ${name}' để áp dụng.`);
}

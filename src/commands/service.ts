import { existsSync, rmSync } from "node:fs";
import { provisionRedis, redisEnvForUnit, rollbackRedis, describeUnitRedis, leaveRedisInstance, type RedisProvision } from "../lib/redis";
import { ensureLogrotate } from "../lib/logrotate";
import { ask } from "../lib/prompt";
import { execCapture, runCmd, runAs, ensureDir, requireRoot, chmodNoFollow } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { validateServiceName, validatePort, validateRepoUrl, validateBranch, validateEnvKey, validateUnitCommand, validateWriteDir } from "../lib/validate";
import {
  ServiceRecord,
  Runtime,
  PackageManager,
  getService,
  requireService,
  upsertService,
  removeService as removeServiceFromState,
  allocatePort,
  serviceUserFor,
  svcSystemdName,
  serviceWorkDirFor,
  findUnit,
  servicesRunningAs,
  SERVICE_DIR_SUFFIX,
  SERVICE_USER_PREFIX,
  SYSTEMD_DIR,
  loadState,
} from "../lib/state";
import { acquireLock } from "../lib/lock";
import { resolveEngine, driverFor, unitEngine, type DbEngine } from "../lib/db";
import { mergeEnvFile, removeEnvKeys, printEnvFile } from "../lib/envfile";
import { unitWorkDir } from "../templates/systemd";
import { detectHardware } from "../lib/hardware";
import { serviceMemoryHighMB } from "../templates/tuning";
import { GIT_NONINTERACTIVE_ENV, prepareRepoAuth, setupRepoAuth } from "../lib/repo";
import { defaultPackageManager, defaultInstallCmd, defaultStartCmd, ensurePackageManager, ensureRuntime } from "../lib/provision";
import { applyNodeHeaps, writeServiceUnit, currentHeapPlan, unitMix, reportBalance } from "./app";

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
  dbEngine?: string; // engine cho --db (bỏ trống = engine mặc định / engine duy nhất đang có)
  redis: boolean;
  redisDb?: number; // index cụ thể — dùng CHUNG keyspace với web app của cùng sản phẩm
  shareRedisWith?: string; // domain/name của đơn vị muốn dùng chung Redis DB
  env: string[]; // "KEY=VALUE"
  allowInsecureRepo?: boolean; // cho phép repo http:// / git:// (không mã hoá)
  token?: string; // PAT clone repo PRIVATE qua HTTPS
  sshKey?: string; // deploy key clone repo PRIVATE qua SSH
  appDir?: string; // monorepo: thư mục con chứa worker, tương đối so với workDir
  runAs?: string; // domain/name của đơn vị cho MƯỢN user hệ thống (worker đụng file của app đó)
  writeDirs: string[]; // đường dẫn ngoài mã nguồn service mà worker được phép GHI
}

// Nơi worker ghi được ngoài thư mục của chính nó. Hai lớp phải khớp nhau thì
// mới ghi được, và mỗi lớp hỏng một kiểu:
//   - Quyền Unix: thư mục app web là 750 / file 640 của user app -> user KHÁC
//     đọc còn không được. Đây là việc của --run-as.
//   - Sandbox systemd: ProtectSystem=strict biến mọi thứ ngoài ReadWritePaths
//     thành chỉ-đọc -> đúng user vẫn ăn EROFS. Đây là việc của writePaths.
// Đường dẫn phải TỒN TẠI: systemd từ chối khởi động unit nếu ReadWritePaths trỏ
// vào chỗ không có, và thông báo lỗi lúc đó ("Failed to set up mount
// namespacing") không hề nhắc tới đường dẫn nào sai.
function resolveWritePaths(dirs: string[], borrowedRoot?: string): string[] {
  const out: string[] = [];
  if (borrowedRoot) out.push(borrowedRoot);
  for (const raw of dirs) {
    const p = raw.trim().replace(/\/+$/, "");
    if (!p.startsWith("/")) die(`--write-dir phải là đường dẫn TUYỆT ĐỐI, nhận được: '${raw}'`);
    if (/\s/.test(p)) die(`--write-dir không được chứa khoảng trắng (systemd tách ReadWritePaths bằng dấu cách): '${raw}'`);
    validateWriteDir(p);
    if (!existsSync(p)) die(`--write-dir '${p}' không tồn tại. systemd sẽ TỪ CHỐI khởi động unit nếu ReadWritePaths trỏ vào chỗ không có — hãy tạo thư mục trước.`);
    out.push(p);
  }
  return [...new Set(out)];
}

function serviceExists(name: string): boolean {
  return getService(name) !== undefined;
}

function assertServiceAbsent(name: string, user: string, borrowedUser: boolean): void {
  const conflicts: string[] = [];
  const workDir = serviceWorkDirFor(name);
  if (existsSync(workDir)) conflicts.push(`thư mục mã nguồn: ${workDir}`);
  // Service nay nằm chung /var/www với app web: chặn trường hợp tên thư mục
  // đụng đúng webRoot của một app đang trong registry (dù thư mục đã bị xoá tay).
  const clash = Object.values(loadState().apps).find((a) => a.webRoot === workDir);
  if (clash) conflicts.push(`app web '${clash.domain}' đang dùng thư mục này`);
  const unit = `${SYSTEMD_DIR}/${svcSystemdName(name)}.service`;
  if (existsSync(unit)) conflicts.push(`systemd unit: ${unit}`);
  // Với --run-as, user CÓ SẴN chính là thứ ta muốn — chỉ coi là xung đột khi
  // service này lẽ ra phải tự tạo user riêng.
  if (!borrowedUser && execCapture("id", [user]).code === 0) conflicts.push(`user hệ thống: ${user}`);
  if (serviceExists(name)) conflicts.push(`registry: đã có service '${name}' trong /etc/napp/state.json`);

  if (conflicts.length > 0) {
    die(
      `Background service '${name}' (hoặc tài nguyên cùng tên) ĐÃ TỒN TẠI — không tạo trùng.\n` +
        conflicts.map((c) => `  - ${c}`).join("\n") +
        `\n  Muốn tạo lại? Hãy xoá trước bằng: napp service delete ${name}`
    );
  }
}

export async function cmdServiceCreate(name: string, opts: CreateServiceOptions): Promise<void> {
  requireRoot();
  validateServiceName(name);
  // Hậu tố '-service' do napp TỰ THÊM vào tên thư mục. Nếu cho phép đặt tên kết
  // thúc bằng '-service' thì service 'mailer' và 'mailer-service' sẽ tranh nhau
  // cùng một thư mục /var/www/mailer-service.
  if (name.endsWith(SERVICE_DIR_SUFFIX)) {
    die(
      `Tên service không được kết thúc bằng '${SERVICE_DIR_SUFFIX}' — napp tự thêm hậu tố này vào tên thư mục.\n` +
        `  Hãy dùng: napp service create ${name.slice(0, -SERVICE_DIR_SUFFIX.length)} ...  (mã nguồn sẽ ở ${serviceWorkDirFor(name.slice(0, -SERVICE_DIR_SUFFIX.length))})`
    );
  }
  validateBranch(opts.branch);
  if (opts.repo) validateRepoUrl(opts.repo, { allowInsecure: opts.allowInsecureRepo });

  // Fail sớm cho xác thực repo private; --ssh-key được resolve thành nội dung key.
  prepareRepoAuth(opts);

  // --run-as: worker chạy bằng user hệ thống của một đơn vị ĐÃ CÓ thay vì user
  // riêng. Cần khi worker đụng vào FILE của app web (nén ảnh trong thư mục
  // upload, sinh thumbnail, dọn cache): user riêng không đọc nổi thư mục 750
  // của app, mà nới quyền thư mục ra cho hai user là mở luôn cho mọi thứ khác.
  const borrowed = opts.runAs ? findUnit(opts.runAs) : undefined;
  if (opts.runAs && !borrowed) {
    die(
      `--run-as: không tìm thấy app/service '${opts.runAs}' trong registry (/etc/napp/state.json).\n` +
        `  Xem danh sách: napp app list · napp service list`
    );
  }
  if (borrowed && execCapture("id", [borrowed.user]).code !== 0) {
    die(
      `--run-as '${borrowed.id}': user hệ thống '${borrowed.user}' không còn tồn tại trên máy (registry và hệ thống lệch nhau).\n` +
        `  Hãy tạo lại đơn vị đó, hoặc bỏ --run-as để service này có user riêng.`
    );
  }

  const user = borrowed ? borrowed.user : serviceUserFor(name);
  const workDir = serviceWorkDirFor(name);
  const writePaths = resolveWritePaths(opts.writeDirs, borrowed?.root);
  // Cổng LÀ TUỲ CHỌN cho background service. Chỉ cấp (và ép Environment=PORT) khi
  // người dùng truyền --port; worker thuần không listen gì thì không cần cổng.
  const port = opts.port !== undefined ? allocatePort(opts.port) : undefined;
  if (port !== undefined) validatePort(port);
  const unitName = svcSystemdName(name);

  assertServiceAbsent(name, user, borrowed !== undefined);

  const pm: PackageManager = opts.packageManager ?? defaultPackageManager(opts.runtime);

  ensureRuntime(opts.runtime);
  // Trình quản lý gói phải dùng được Ở MỨC HỆ THỐNG (user service + systemd đều thấy).
  ensurePackageManager(pm);
  const dbEngine: DbEngine | undefined = opts.db ? resolveEngine(opts.dbEngine) : undefined;

  const release = acquireLock(name);
  let rollbackActive = true;
  let dbCreatedName: string | undefined;
  let redisProv: RedisProvision = {}; // Redis riêng vừa tạo/tham gia -> rollback phải gỡ
  const rollback = () => {
    if (!rollbackActive) return;
    warn("Tạo service thất bại — đang hoàn tác các thay đổi đã thực hiện...");
    try {
      runCmd("systemctl", ["stop", unitName], { silentFail: true });
      runCmd("systemctl", ["disable", unitName], { silentFail: true });
      runCmd("rm", ["-f", `${SYSTEMD_DIR}/${unitName}.service`], { silentFail: true });
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
      // User MƯỢN là của đơn vị khác đang chạy — hoàn tác mà xoá nó là kéo sập
      // app web chỉ vì worker tạo hỏng. Chỉ xoá user do chính lần này tạo ra.
      if (!borrowed && execCapture("id", [user]).code === 0) {
        runCmd("userdel", ["-r", user], { silentFail: true });
      }
      rollbackRedis(redisProv, name, user);
      if (dbCreatedName) {
        try {
          driverFor(dbEngine!).drop(dbCreatedName, dbCreatedName);
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

    // --- user hệ thống: riêng (cô lập) hoặc MƯỢN của đơn vị khác (--run-as) ---
    if (borrowed) {
      ok(`Chạy bằng user '${user}' của ${borrowed.kind === "app" ? "app web" : "service"} '${borrowed.id}' — không tạo user mới.`);
      warn(
        `--run-as ĐÁNH ĐỔI SỰ CÔ LẬP để lấy quyền ghi file:\n` +
          `  - Worker này và '${borrowed.id}' là CÙNG MỘT danh tính Unix. Worker đọc/ghi được\n` +
          `    mọi thứ của '${borrowed.id}', kể cả .env (mật khẩu DB, khoá API) — và ngược lại.\n` +
          `  - Một bên bị chiếm quyền là bên kia mất theo. Chỉ dùng khi hai bên là hai nửa của\n` +
          `    CÙNG một sản phẩm; hai sản phẩm khác nhau thì đừng dùng.\n` +
          `  - Gỡ service này về sau sẽ KHÔNG xoá user (user thuộc về '${borrowed.id}').`
      );
    } else {
      runCmd("useradd", ["--system", "--create-home", "--home-dir", `/home/${user}`, "--shell", "/usr/sbin/nologin", user]);
      ok(`Đã tạo user hệ thống ${user}`);
    }

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
    validateUnitCommand(installCmd, "--install-cmd");
    validateUnitCommand(buildCmd, "--build-cmd");
    validateUnitCommand(startCmd, "--start-cmd");

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
    if (dbEngine) {
      dbInfo = driverFor(dbEngine).create(user, user);
      dbCreatedName = dbInfo.name;
      ok(`Đã tạo database ${driverFor(dbEngine).label} '${dbInfo.name}' + user CSDL '${dbInfo.user}'`);
    }

    // --- redis (tuỳ chọn) ---
    // Mặc định: Redis RIÊNG có mật khẩu (lib/redis.ts). --share-redis-with: dùng
    // chung instance của app kia (BẮT BUỘC cho worker tiêu thụ hàng đợi của app đó).
    redisProv = provisionRedis(name, user, { redis: opts.redis, redisDb: opts.redisDb, shareRedisWith: opts.shareRedisWith });
    const { redisInstance, redisDbIndex } = redisProv;
    if (redisProv.createdInstance) {
      // Một worker gần như luôn là NỬA KIA của một web app: hàng đợi chỉ chạy khi
      // bên đẩy và bên tiêu thụ nhìn CÙNG một Redis. Redis riêng ở đây đúng cho
      // worker độc lập, nhưng SAI cho cặp web+worker — và sai hoàn toàn im lặng.
      warn(
        `Service này có Redis RIÊNG ('${redisProv.createdInstance}').\n` +
          `  Nếu nó là worker xử lý hàng đợi của một web app, hai bên PHẢI dùng chung một Redis —\n` +
          `  khác Redis thì job đẩy vào một nơi, worker nghe một nơi, KHÔNG BÊN NÀO BÁO LỖI.\n` +
          `  Tạo lại với: --share-redis-with <domain-cua-web-app>`
      );
    }

    // --- .env ---
    // KHÁC web app: service không chạy sau reverse proxy nên KHÔNG có APP_URL/
    // PROTOCOL_HEADER/HOST_HEADER/XFF_DEPTH (những biến chỉ có nghĩa sau nginx).
    // Chỉ ghi NODE_ENV, PORT (nếu có), thông tin DB/Redis, và biến người dùng thêm.
    const envUpdates: Record<string, string> = { NODE_ENV: "production" };
    if (port !== undefined) envUpdates.PORT = String(port);
    if (dbInfo && dbEngine) Object.assign(envUpdates, driverFor(dbEngine).envFor(dbInfo));
    Object.assign(envUpdates, redisEnvForUnit(redisProv));
    for (const kv of opts.env) {
      const eq = kv.indexOf("=");
      if (eq === -1) die(`--env phải theo dạng KEY=VALUE, nhận được: '${kv}'`);
      const key = kv.slice(0, eq);
      validateEnvKey(key);
      envUpdates[key] = kv.slice(eq + 1);
    }
    // Phải ĐÚNG chỗ systemd đọc (EnvironmentFile = <workDir>/.env). Xem app.ts.
    const svcWorkDir = unitWorkDir(workDir, opts.appDir);
    if (svcWorkDir !== workDir) ensureDir(svcWorkDir);
    const envPath = `${svcWorkDir}/.env`;
    mergeEnvFile(envPath, envUpdates, 0o600, user);
    ok("Đã ghi cấu hình vào .env (quyền 600, chỉ user của service đọc được)");

    // --- phân quyền chuẩn ---
    runCmd("chown", ["-hR", `${user}:${user}`, workDir]);
    runCmd("find", [workDir, "-type", "d", "-exec", "chmod", "750", "{}", "+"]);
    runCmd("find", [workDir, "-type", "f", "-exec", "chmod", "640", "{}", "+"]);

    // --- systemd service ---
    ensureDir("/var/log/napp", 0o750);
    ensureLogrotate(); // log app không được phình vô hạn
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
      dbEngine: dbInfo ? dbEngine : undefined,
      redisInstance,
      redisDbIndex,
      appDir: opts.appDir,
      runAsUnit: borrowed?.id,
      writePaths: writePaths.length > 0 ? writePaths : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Heap V8 chỉ đặt cho runtime node. Chia theo TỔNG số đơn vị node (app + service)
    // SAU khi thêm service này để cân đối RAM; user có thể ghi đè NODE_OPTIONS trong .env.
    //
    // Background service được phần NHỎ HƠN web app (mặc định một nửa): worker
    // chậm đi thì không ai thấy, web app chậm đi thì mọi người dùng đều thấy.
    const plan = currentHeapPlan({ services: 1 });
    const heapMB = plan.serviceMB;
    // Service mới -> unit chưa có, writeServiceUnit ghi thẳng bản template kèm
    // fingerprint để lần sửa tay đầu tiên của người dùng được nhận ra và giữ lại.
    writeServiceUnit(record, heapMB);
    if (opts.runtime === "node") {
      info(
        `NODE_OPTIONS=--max-old-space-size=${heapMB} (background service nhận phần nhỏ hơn web app: ` +
          `${plan.serviceMB} MB so với ${plan.webMB} MB; đổi trong .env nếu cần)`
      );
    }
    info(
      `Ưu tiên tài nguyên: CPUWeight/IOWeight thấp hơn web app + MemoryHigh ${serviceMemoryHighMB(heapMB)} MB (giới hạn MỀM) — ` +
        `worker nén ảnh/video sẽ không làm chậm request của người dùng thật khi tranh chấp CPU.`
    );
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["enable", unitName]);
    runCmd("systemctl", ["restart", unitName]);
    ok(`Đã tạo và khởi động systemd service '${unitName}'`);

    upsertService(record);
    rollbackActive = false;
    release();

    // Cân đối lại heap V8 giữa các đơn vị node còn lại (service vừa tạo đã chạy
    // với heap đúng nên bỏ qua restart nó).
    const mixNow = unitMix();
    if (mixNow.webApps + mixNow.services > 1) reportBalance(applyNodeHeaps({ restart: true, skipRestartFor: name }));

    console.log();
    console.log("===============================================================");
    ok("Tạo background service thành công!");
    console.log(`  Tên service  : ${name}`);
    console.log(`  Mã nguồn     : ${workDir}`);
    console.log(`  Chạy bằng    : ${user}${borrowed ? ` — user của '${borrowed.id}' (dùng chung danh tính)` : " (user riêng)"} (systemd: ${unitName})`);
    if (writePaths.length > 0) console.log(`  Ghi được vào : ${workDir} · ${writePaths.join(" · ")}`);
    console.log(`  Runtime      : ${opts.runtime} · quản lý gói: ${pm}`);
    if (port !== undefined) console.log(`  Cổng nội bộ  : 127.0.0.1:${port} (service tự bind — KHÔNG public qua nginx)`);
    else console.log(`  Cổng         : không cấp (worker chạy ngầm, không listen)`);
    if (dbInfo && dbEngine) console.log(`  Database     : ${driverFor(dbEngine).label} '${dbInfo.name}'  (user: ${dbInfo.user}, mật khẩu + DATABASE_URL trong .env)`);
    if (redisInstance || redisDbIndex !== undefined) console.log(`  Redis        : ${describeUnitRedis(redisProv)}`);
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

    runCmd("chown", ["-hR", `${svc.user}:${svc.user}`, svc.workDir]);
    chmodNoFollow(`${unitWorkDir(svc.workDir, svc.appDir)}/.env`, 0o600);

    runCmd("systemctl", ["restart", svcSystemdName(name)]);
    svc.updatedAt = new Date().toISOString();
    upsertService(svc);
    ok(`Deploy hoàn tất — đã khởi động lại ${svcSystemdName(name)}`);
  } finally {
    release();
  }
}

export interface ServiceSetOptions {
  runAs?: string; // chuyển sang chạy bằng user của đơn vị này
  standalone?: boolean; // ngược lại: về user riêng của service
  writeDirs: string[]; // thay TOÀN BỘ danh sách đường dẫn ghi thêm (ngoài gốc của --run-as)
  clearWriteDirs?: boolean;
}

/**
 * Đổi DANH TÍNH và QUYỀN GHI của một service ĐÃ TẠO.
 *
 * Có lệnh này vì `--run-as` lúc tạo là không đủ: nhu cầu "worker nén ảnh trong
 * thư mục app web" thường lộ ra SAU khi worker đã chạy được vài tuần, và cách
 * duy nhất còn lại là xoá đi tạo lại (mất .env, mất database nếu lỡ tay).
 */
export async function cmdServiceSet(name: string, opts: ServiceSetOptions): Promise<void> {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);

  if (opts.runAs && opts.standalone) die("--run-as và --standalone loại trừ nhau: hoặc mượn user của đơn vị khác, hoặc dùng user riêng.");
  if (!opts.runAs && !opts.standalone && opts.writeDirs.length === 0 && !opts.clearWriteDirs) {
    die(
      `Không có gì để đổi. Các tuỳ chọn:\n` +
        `  --run-as <domain|name>  chạy bằng user của app/service đã có (worker ghi được vào thư mục của nó)\n` +
        `  --standalone            quay về user riêng '${serviceUserFor(name)}' (cô lập hoàn toàn)\n` +
        `  --write-dir <path>      đặt lại danh sách đường dẫn được ghi thêm (lặp lại được)\n` +
        `  --no-write-dir          bỏ hết đường dẫn ghi thêm`
    );
  }

  const release = acquireLock(name);
  try {
    section(`Đổi cấu hình chạy của service ${name}`);
    const oldUser = svc.user;

    let borrowed = svc.runAsUnit ? findUnit(svc.runAsUnit) : undefined;
    // Gốc của đơn vị đang cho mượn, chụp TRƯỚC khi `borrowed` bị thay. Chuyển
    // --run-as từ app A sang app B mà không nhớ gốc cũ thì thư mục của A nằm
    // lại trong writePaths như một đường dẫn "người dùng tự thêm": worker vẫn
    // ghi được vào app A dù không còn liên quan gì tới nó nữa.
    const previousRoot = borrowed?.root;
    if (opts.runAs) {
      const target = findUnit(opts.runAs);
      if (!target) die(`--run-as: không tìm thấy app/service '${opts.runAs}' trong registry. Xem: napp app list · napp service list`);
      if (execCapture("id", [target!.user]).code !== 0) die(`--run-as '${target!.id}': user hệ thống '${target!.user}' không tồn tại trên máy.`);
      borrowed = target;
      svc.user = target!.user;
      svc.runAsUnit = target!.id;
    } else if (opts.standalone) {
      const own = serviceUserFor(name);
      if (execCapture("id", [own]).code !== 0) {
        runCmd("useradd", ["--system", "--create-home", "--home-dir", `/home/${own}`, "--shell", "/usr/sbin/nologin", own]);
        ok(`Đã tạo user hệ thống riêng '${own}'.`);
      }
      borrowed = undefined;
      svc.user = own;
      svc.runAsUnit = undefined;
    }

    // writePaths luôn được TÍNH LẠI từ đầu: gốc của đơn vị cho mượn (nếu còn
    // mượn) + danh sách --write-dir lần này. Cộng dồn ngầm là cách nhanh nhất
    // để một service tích tụ quyền ghi mà không ai nhớ vì sao nó có.
    const keepDirs = opts.clearWriteDirs
      ? []
      : opts.writeDirs.length > 0
        ? opts.writeDirs
        : (svc.writePaths ?? []).filter((p) => p !== borrowed?.root && p !== previousRoot);
    const writePaths = resolveWritePaths(keepDirs, borrowed?.root);
    svc.writePaths = writePaths.length > 0 ? writePaths : undefined;

    if (svc.user !== oldUser) {
      runCmd("chown", ["-hR", `${svc.user}:${svc.user}`, svc.workDir]);
      chmodNoFollow(`${unitWorkDir(svc.workDir, svc.appDir)}/.env`, 0o600);
      ok(`Mã nguồn ${svc.workDir} đã chuyển sang user '${svc.user}'.`);
    }

    svc.updatedAt = new Date().toISOString();
    upsertService(svc);

    // User/Group/ReadWritePaths trong unit vừa đổi theo registry -> phải render
    // lại unit NÀY. `authoritative` nói rõ User/Group lần này do napp quyết
    // định: đây chính là thứ người dùng vừa yêu cầu đổi, giữ bản sửa tay cũ ở
    // đây là làm ngược lại ý họ. Các directive khác họ sửa vẫn được giữ nguyên.
    writeServiceUnit(svc, currentHeapPlan().serviceMB, ["User", "Group"]);
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["restart", svcSystemdName(name)]);

    if (svc.runAsUnit) {
      ok(`Service '${name}' nay chạy bằng user '${svc.user}' của '${svc.runAsUnit}'.`);
      warn(
        `Hai bên nay là CÙNG MỘT danh tính Unix: worker đọc/ghi được mọi thứ của '${svc.runAsUnit}' (kể cả .env) và ngược lại. ` +
          `Chỉ nên dùng khi chúng là hai nửa của cùng một sản phẩm.`
      );
    } else {
      ok(`Service '${name}' nay chạy bằng user riêng '${svc.user}'.`);
    }
    if (writePaths.length > 0) info(`Ghi được vào: ${svc.workDir} · ${writePaths.join(" · ")}`);
    else info(`Ghi được vào: ${svc.workDir} (chỉ mã nguồn của chính nó)`);

    // User cũ chỉ nên xoá bằng tay: nó có thể vẫn đang chạy app web khác.
    if (svc.user !== oldUser && oldUser.startsWith(SERVICE_USER_PREFIX) && servicesRunningAs(name, oldUser).length === 0) {
      const stillUsed = Object.values(loadState().services).some((s) => s.user === oldUser);
      if (!stillUsed) info(`User cũ '${oldUser}' không còn đơn vị nào dùng. Muốn dọn: sudo userdel -r ${oldUser}`);
    }
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
    ...(opts.source ? [svc.runAsUnit ? `mã nguồn (${svc.workDir}) — GIỮ user '${svc.user}' vì nó thuộc về '${svc.runAsUnit}'` : `mã nguồn (${svc.workDir}) + user hệ thống '${svc.user}'`] : []),
    ...(opts.database && svc.dbName ? [`database '${svc.dbName}'`] : []),
  ];
  const willKeep = [
    ...(!opts.source ? [`mã nguồn (${svc.workDir})`] : []),
    ...(!opts.database && svc.dbName ? [`database '${svc.dbName}'`] : []),
  ];

  if (!opts.yes) {
    const ans = await ask(
      `Thao tác này sẽ gỡ service '${name}' khỏi napp và XOÁ:\n` +
        willDelete.map((w) => `  - ${w}`).join("\n") +
        (willKeep.length ? `\nGIỮ lại:\n` + willKeep.map((w) => `  - ${w}`).join("\n") : "") +
        `\nTiếp tục? [y/N] `
    );
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
      // User đi MƯỢN (--run-as) là danh tính của app web đang chạy — xoá nó ở
      // đây là app web chết ngay lần khởi động sau, vì một lệnh không hề nhắc
      // tới app web đó.
      const borrowers = servicesRunningAs(name, svc.user).filter((s) => s.name !== name);
      if (svc.runAsUnit) {
        info(`Giữ user hệ thống '${svc.user}' — user này thuộc về '${svc.runAsUnit}', service chỉ mượn để chạy.`);
      } else if (borrowers.length > 0) {
        warn(
          `GIỮ LẠI user hệ thống '${svc.user}' — ${borrowers.length} service khác đang chạy bằng user này (--run-as): ${borrowers.map((s) => s.name).join(", ")}.\n` +
            `  Xoá user đi là chúng chết ngay lần khởi động sau.`
        );
      } else if (execCapture("id", [svc.user]).code === 0) {
        runCmd("userdel", ["-r", svc.user], { silentFail: true });
        ok(`Đã xoá user hệ thống '${svc.user}'.`);
      }
    } else {
      info(`Giữ lại mã nguồn ${svc.workDir} và user hệ thống '${svc.user}'.`);
    }

    if (opts.database) {
      if (svc.dbName) {
        try {
          driverFor(unitEngine(svc)).drop(svc.dbName, svc.dbUser);
          ok(`Đã xoá database '${svc.dbName}'.`);
        } catch (e) {
          warn(`Không xoá được database '${svc.dbName}' (${(e as Error).message}). Hãy tự xoá sau bằng 'napp db delete ${svc.dbName} --engine ${unitEngine(svc)} --yes --user ${svc.dbUser ?? svc.dbName}'.`);
        }
      } else {
        info("Service không có database riêng — bỏ qua.");
      }
    } else if (svc.dbName) {
      info(`Giữ lại database '${svc.dbName}'. Muốn xoá sau: napp db delete ${svc.dbName} --engine ${unitEngine(svc)} --yes --user ${svc.dbUser ?? svc.dbName}`);
    }

    if (svc.redisInstance) leaveRedisInstance(svc.redisInstance, name, svc.user, { purgeData: opts.source && opts.database });
    removeServiceFromState(name);
    ok(`Đã gỡ service '${name}' khỏi napp.`);

    // Cân đối lại heap V8 cho các đơn vị node còn lại — nay được chia phần RAM lớn hơn.
    const mixAfter = unitMix();
    if (mixAfter.webApps + mixAfter.services > 0) reportBalance(applyNodeHeaps({ restart: true }));
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
        svc.runAsUnit ? `run-as=${svc.runAsUnit} ` : ""
      }${svc.dbName ? `db=${unitEngine(svc)}:${svc.dbName} ` : ""}${svc.redisInstance ? "redis=riêng " : svc.redisDbIndex !== undefined ? `redis=#${svc.redisDbIndex}(chung) ` : ""}${running ? "đang chạy" : "ĐÃ DỪNG"}`
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
  // Cùng đường dẫn systemd đọc — ghi ở gốc repo thì unit của monorepo không thấy.
  const svcEnv = `${unitWorkDir(svc.workDir, svc.appDir)}/.env`;
  mergeEnvFile(svcEnv, updates, 0o600, svc.user);
  ok(`Đã cập nhật .env cho service '${name}'. Chạy 'napp service restart ${name}' để áp dụng.`);
}

export function cmdServiceEnvList(name: string, opts: { reveal: boolean }): void {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);
  const svcEnv = `${unitWorkDir(svc.workDir, svc.appDir)}/.env`;
  section(`.env của service '${name}' (${svcEnv})`);
  printEnvFile(svcEnv, opts.reveal);
}

export function cmdServiceEnvUnset(name: string, keys: string[]): void {
  requireRoot();
  validateServiceName(name);
  const svc = requireService(name);
  for (const k of keys) validateEnvKey(k);
  const svcEnv = `${unitWorkDir(svc.workDir, svc.appDir)}/.env`;
  const removed = removeEnvKeys(svcEnv, keys, 0o600, svc.user);
  const missing = keys.filter((k) => !removed.includes(k));
  if (missing.length > 0) warn(`Không có trong .env: ${missing.join(", ")}`);
  if (removed.length === 0) return;
  ok(`Đã xoá ${removed.join(", ")} khỏi .env của service '${name}'. Chạy 'napp service restart ${name}' để áp dụng.`);
}

export function cmdServiceShow(name: string): void {
  validateServiceName(name);
  const svc = requireService(name);
  const unit = svcSystemdName(name);
  const running = execCapture("systemctl", ["is-active", "--quiet", unit]).code === 0;
  section(`Service ${name}`);
  const rows: [string, string | undefined][] = [
    ["Trạng thái", running ? "đang chạy" : "ĐÃ DỪNG"],
    ["Mã nguồn", svc.workDir + (svc.appDir ? ` (worker ở ${svc.appDir})` : "")],
    ["Repo", svc.repoUrl ? `${svc.repoUrl} @ ${svc.branch}` : "- (worker mẫu)"],
    ["Chạy bằng", `${svc.user}${svc.runAsUnit ? ` (mượn của '${svc.runAsUnit}')` : ""} · systemd ${unit}`],
    ["Ghi thêm vào", svc.writePaths?.length ? svc.writePaths.join(", ") : "-"],
    ["Cổng nội bộ", svc.port !== undefined ? `127.0.0.1:${svc.port}` : "-"],
    ["Runtime", `${svc.nodeRuntime} · ${svc.packageManager ?? "npm"}`],
    ["Lệnh", `install: ${svc.installCmd} · build: ${svc.buildCmd || "-"} · start: ${svc.startCmd}`],
    ["Database", svc.dbName ? `${driverFor(unitEngine(svc)).label} '${svc.dbName}' (user ${svc.dbUser ?? svc.dbName})` : "-"],
    ["Redis", describeUnitRedis(svc)],
    ["Leak guard", svc.leakGuard ? "bật" : undefined],
    ["Tạo lúc", svc.createdAt],
  ];
  for (const [k, v] of rows) if (v !== undefined) console.log(`  ${k.padEnd(14)}: ${v}`);
}

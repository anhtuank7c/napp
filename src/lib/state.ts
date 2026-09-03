import { existsSync, readFileSync } from "node:fs";
import { writeFile, ensureDir, state as execState } from "./exec";
import { die } from "./log";

export const NAPP_ROOT = "/etc/napp";
export const STATE_PATH = `${NAPP_ROOT}/state.json`;
export const WWW_ROOT = "/var/www";
export const SOCK_DIR = "/run/napp"; // không dùng socket cho node (dùng TCP loopback), giữ lại cho tiện mở rộng
export const NGINX_AVAILABLE = "/etc/nginx/sites-available";
export const NGINX_ENABLED = "/etc/nginx/sites-enabled";
export const SYSTEMD_DIR = "/etc/systemd/system";
export const USER_PREFIX = "na_";
// Background service (chạy ngầm, KHÔNG domain/nginx): mã nguồn đặt CÙNG CHỖ với
// app web (/var/www) để mọi mã nguồn napp quản lý nằm một nơi, khỏi phân mảnh
// thư mục và khỏi phải đi tìm. Phân biệt bằng HẬU TỐ '-service' trong tên thư
// mục (app web giữ nguyên tên domain). Nginx KHÔNG phục vụ thư mục này vì
// không có vhost nào trỏ tới nó — nằm trong /var/www không làm nó public.
// User prefix + tên systemd vẫn riêng để KHÔNG bao giờ đụng tài nguyên của
// web app dù slug có trùng.
export const SERVICE_DIR_SUFFIX = "-service";
export const SERVICE_USER_PREFIX = "nas_";
export const BACKUP_ROOT = "/var/backups/napp";
export const PORT_RANGE_START = 3000;
export const PORT_RANGE_END = 3999;
export const REDIS_DB_MAX = 16; // Redis mặc định có 16 database (0-15)

export type Runtime = "node" | "bun";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface AppRecord {
  domain: string;
  aliasDomains: string[]; // domain phụ trỏ vào cùng app (www, hoặc domain khác)
  user: string;
  webRoot: string;
  port: number;
  nodeRuntime: Runtime;
  packageManager?: PackageManager; // trình quản lý gói phụ thuộc (npm/pnpm/yarn/bun)
  nodeVersion?: string; // ví dụ "22" — dùng khi máy có nhiều bản Node qua nvm
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  repoUrl?: string;
  branch: string;
  dbName?: string;
  dbUser?: string;
  redisDbIndex?: number;
  // Thư mục con chứa ứng dụng thật, TƯƠNG ĐỐI so với webRoot. Chỉ dùng cho
  // monorepo (vd "apps/backend"): mã nguồn vẫn clone nguyên repo vào webRoot,
  // nhưng WorkingDirectory và .env của systemd trỏ vào thư mục con này.
  appDir?: string;
  // client_max_body_size của nginx. Bỏ trống -> 20M.
  maxBodySize?: string;
  // Asset build được nginx trả thẳng từ đĩa (xem NginxAppOptions).
  staticRoot?: string;
  staticPrefixes?: string[];
  // Tiền tố URL phục vụ bằng `alias` thay vì `root` + try_files. Cần khi đoạn
  // URL và tên thư mục trên đĩa KHÁC NHAU — Next.js là ca điển hình: URL
  // '/_next/static/' nhưng file nằm ở '.next/static/'. Xem templates/nginx.ts.
  staticAliases?: { prefix: string; dir: string }[];
  // Framework nhận diện được lúc tạo/áp cấu hình tĩnh (lib/framework.ts). Chỉ
  // để hiển thị và để bản napp sau suy lại tiền tố khi framework đổi quy ước —
  // KHÔNG có logic nào rẽ nhánh theo giá trị này.
  framework?: string;
  // Thư mục file tải lên lúc CHẠY (khác staticRoot — xem NginxAppOptions).
  uploadDir?: string;
  uploadPrefix?: string;
  // Chặn hotlink ảnh (chỉ cho nhúng từ domain của site). Xem NginxAppOptions.
  hotlinkProtect?: boolean;
  hotlinkAllow?: string[];
  // Bỏ 'none' và 'blocked' khỏi valid_referers. Chặt hơn, nhưng mất ảnh preview
  // khi chia sẻ link và 403 nhầm người dùng sau proxy công ty — xem nginx.ts.
  hotlinkStrict?: boolean;
  // Chặn quét lỗ hổng CMS/framework PHP (.php, /wp-admin/, /phpmyadmin/... -> 444).
  // undefined = BẬT (mặc định của cả server, xem `napp nginx scanblock`); chỉ
  // false mới bỏ dòng include khỏi file location của site này. Mặc định-bật là
  // có chủ đích: app tạo bằng bản napp cũ cũng phải được bảo vệ sau khi nâng cấp
  // mà không cần ai nhớ bật thêm cờ nào.
  scanBlock?: boolean;
  // Bật hai cờ chẩn đoán rò rỉ của Node vào NODE_OPTIONS:
  //   --heapsnapshot-signal=SIGUSR2      chụp heap theo yêu cầu, app vẫn sống
  //   --heapsnapshot-near-heap-limit=1   TỰ chụp ngay trước khi chết vì OOM
  // Cả hai đều được phép trong NODE_OPTIONS nên KHÔNG phải sửa code app hay
  // ExecStart. Chỉ có nghĩa với runtime node (bun dùng JSC, không hiểu cờ V8).
  leakGuard?: boolean;
  createdAt: string;
  updatedAt: string;
}

// Ứng dụng chạy NGẦM (background service): worker, bot, queue consumer, cron
// poller... KHÔNG có domain, KHÔNG nginx/SSL. Định danh bằng `name`. Cổng là
// TUỲ CHỌN (chỉ có khi người dùng truyền --port; service thuần worker không
// listen gì cả). Tái sử dụng phần lifecycle chung với AppRecord (user riêng,
// systemd, clone/deploy, db/redis, heap V8) nhưng bỏ toàn bộ phần web.
export interface ServiceRecord {
  name: string;
  user: string;
  workDir: string;
  nodeRuntime: Runtime;
  packageManager?: PackageManager;
  nodeVersion?: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  port?: number; // chỉ có khi tạo với --port (service tự bind); không public qua nginx
  repoUrl?: string;
  branch: string;
  dbName?: string;
  dbUser?: string;
  redisDbIndex?: number;
  // Như AppRecord.appDir — monorepo: WorkingDirectory/.env trỏ vào thư mục con.
  appDir?: string;
  // Đơn vị (domain web app hoặc name service) mà service này MƯỢN user hệ thống
  // (`--run-as`). Bỏ trống = service có user riêng do napp tạo, cô lập hoàn toàn.
  // Có giá trị = user thuộc về đơn vị kia, nên napp KHÔNG BAO GIỜ được xoá user
  // đó khi gỡ service này (xoá là app web mất luôn danh tính đang chạy).
  runAsUnit?: string;
  // Đường dẫn NGOÀI workDir mà unit được phép ghi. Cần vì ProtectSystem=strict
  // biến toàn bộ filesystem thành chỉ-đọc: worker nén ảnh trong thư mục của app
  // web có đúng quyền Unix vẫn ăn EROFS nếu đường dẫn không nằm ở đây.
  writePaths?: string[];
  // Bật hai cờ chẩn đoán rò rỉ của Node vào NODE_OPTIONS:
  //   --heapsnapshot-signal=SIGUSR2      chụp heap theo yêu cầu, app vẫn sống
  //   --heapsnapshot-near-heap-limit=1   TỰ chụp ngay trước khi chết vì OOM
  // Cả hai đều được phép trong NODE_OPTIONS nên KHÔNG phải sửa code app hay
  // ExecStart. Chỉ có nghĩa với runtime node (bun dùng JSC, không hiểu cờ V8).
  leakGuard?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NappState {
  version: 1;
  apps: Record<string, AppRecord>; // key = domain chính
  services: Record<string, ServiceRecord>; // key = name (background service, không domain)
  usedPorts: number[];
  usedRedisDb: number[];
  acmeEmail?: string; // email đã dùng đăng ký Let's Encrypt — nhớ để đỡ nhập lại
  // Trọng số heap của background service so với web app (mặc định 0.5 — web app
  // được gấp đôi). LƯU LẠI chứ không chỉ là cờ của một lần chạy: `tune apply
  // --service-weight` mà không nhớ thì lần `app create` kế tiếp sẽ tính lại theo
  // mặc định và âm thầm lật ngược lựa chọn của người dùng — cùng loại trôi cấu
  // hình mà cả module unitfile.ts sinh ra để ngăn.
  serviceHeapWeight?: number;
}

function emptyState(): NappState {
  return { version: 1, apps: {}, services: {}, usedPorts: [], usedRedisDb: [] };
}

let cache: NappState | null = null;

export function loadState(): NappState {
  if (cache) return cache;
  if (!existsSync(STATE_PATH)) {
    cache = emptyState();
    return cache;
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    cache = JSON.parse(raw) as NappState;
    cache.apps ??= {};
    cache.services ??= {}; // state cũ (trước khi có background service) không có khoá này
    cache.usedPorts ??= [];
    cache.usedRedisDb ??= [];
    return cache;
  } catch (e) {
    die(`Không đọc được ${STATE_PATH} (file registry bị hỏng?): ${(e as Error).message}`);
  }
}

export function saveState(s: NappState): void {
  cache = s;
  ensureDir(NAPP_ROOT, 0o750);
  // Ở chế độ dry-run, writeFile chỉ in ra chứ không ghi thật — an toàn.
  writeFile(STATE_PATH, JSON.stringify(s, null, 2) + "\n", 0o640);
  // Khi dry-run, không lưu cache thay đổi để tránh làm lệch trạng thái các
  // lệnh readonly chạy sau trong cùng tiến trình (không xảy ra thực tế vì
  // mỗi lần gọi napp là một process riêng, nhưng an toàn hơn).
  if (execState.dryRun) cache = null;
}

export function getAcmeEmail(): string | undefined {
  return loadState().acmeEmail;
}

export function setAcmeEmail(email: string): void {
  const s = loadState();
  s.acmeEmail = email;
  saveState(s);
}

export function getApp(domain: string): AppRecord | undefined {
  return loadState().apps[domain];
}

export function requireApp(domain: string): AppRecord {
  const app = getApp(domain);
  if (!app) {
    die(
      `Không tìm thấy app cho domain '${domain}' trong registry (${STATE_PATH}).\n` +
        `  Chạy 'napp app list' để xem danh sách, hoặc 'napp app create ${domain} ...' để tạo mới.`
    );
  }
  return app;
}

export function upsertApp(app: AppRecord): void {
  const s = loadState();
  s.apps[app.domain] = app;
  if (!s.usedPorts.includes(app.port)) s.usedPorts.push(app.port);
  if (app.redisDbIndex !== undefined && !s.usedRedisDb.includes(app.redisDbIndex)) {
    s.usedRedisDb.push(app.redisDbIndex);
  }
  saveState(s);
}

/**
 * Trả một Redis DB về danh sách trống — CHỈ KHI không còn app/service nào dùng.
 *
 * Một index có thể được nhiều đơn vị dùng CHUNG (web + worker của cùng sản phẩm
 * BẮT BUỘC nằm chung keyspace, xem --redis-db). Nếu cứ xoá đơn vị nào là gỡ
 * index đó ra khỏi usedRedisDb thì DB vẫn đang được đơn vị còn lại sử dụng lại
 * bị coi là trống, và lần `napp app create --redis` kế tiếp sẽ cấp trùng — hai
 * sản phẩm khác nhau ghi đè key của nhau, không có lỗi nào được báo.
 *
 * Gọi SAU khi đã xoá đơn vị khỏi state.
 */
function releaseRedisDbIfUnused(s: NappState, index: number | undefined): void {
  if (index === undefined) return;
  const stillUsed =
    Object.values(s.apps).some((a) => a.redisDbIndex === index) ||
    Object.values(s.services).some((v) => v.redisDbIndex === index);
  if (!stillUsed) s.usedRedisDb = s.usedRedisDb.filter((d) => d !== index);
}

export function removeApp(domain: string): AppRecord | undefined {
  const s = loadState();
  const app = s.apps[domain];
  if (!app) return undefined;
  delete s.apps[domain];
  s.usedPorts = s.usedPorts.filter((p) => p !== app.port);
  releaseRedisDbIfUnused(s, app.redisDbIndex);
  saveState(s);
  return app;
}

export function allocatePort(preferred?: number): number {
  const s = loadState();
  if (preferred !== undefined) {
    if (s.usedPorts.includes(preferred)) {
      die(`Cổng ${preferred} đã được app khác sử dụng. Hãy chọn cổng khác hoặc bỏ trống --port để tự động cấp phát.`);
    }
    return preferred;
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!s.usedPorts.includes(p)) return p;
  }
  die(`Đã hết cổng trống trong dải ${PORT_RANGE_START}-${PORT_RANGE_END}. Hãy chỉ định --port thủ công ngoài dải này.`);
}

export function allocateRedisDb(): number | undefined {
  const s = loadState();
  for (let i = 1; i < REDIS_DB_MAX; i++) {
    // DB 0 dành cho mục đích chung / để trống, bắt đầu cấp phát từ DB 1.
    if (!s.usedRedisDb.includes(i)) return i;
  }
  return undefined; // hết chỗ — caller sẽ cảnh báo dùng key-prefix thay vì DB riêng
}

/**
 * Redis DB cho một đơn vị sắp tạo: index chỉ định (dùng chung) hoặc cấp mới.
 *
 * Vì sao phải cho dùng CHUNG: napp coi mỗi app/service là một hệ độc lập và cấp
 * cho mỗi bên một DB riêng. Điều đó đúng với hai sản phẩm khác nhau, nhưng SAI
 * với web + worker của CÙNG một sản phẩm — hàng đợi (BullMQ, Sidekiq, Celery...)
 * chỉ hoạt động khi bên đẩy việc và bên tiêu thụ nhìn vào cùng một keyspace.
 * Khác DB thì web đẩy job vào DB #1, worker ngồi nghe DB #2; KHÔNG bên nào báo
 * lỗi, job cứ chất đống và mọi tác dụng phụ (email, thông báo, resize ảnh) im
 * lặng không bao giờ chạy.
 *
 * Index chỉ định CỐ Ý không bị từ chối khi đã có đơn vị khác dùng — dùng chung
 * chính là mục đích. Đổi lại, `releaseRedisDbIfUnused` phải đếm tham chiếu khi
 * xoá, nếu không DB đang dùng sẽ bị cấp lại cho sản phẩm khác.
 */
export function resolveRedisDb(preferred?: number): number | undefined {
  if (preferred === undefined) return allocateRedisDb();
  if (!Number.isInteger(preferred) || preferred < 0 || preferred >= REDIS_DB_MAX) {
    die(`--redis-db không hợp lệ: ${preferred} (hợp lệ: 0-${REDIS_DB_MAX - 1})`);
  }
  return preferred;
}

/**
 * Redis DB mà một app (theo domain) hoặc service (theo name) đang dùng.
 * Dùng cho `--share-redis-with`, để không phải tra tay rồi gõ lại số.
 */
export function redisDbOf(identifier: string): number {
  const s = loadState();
  const unit = s.apps[identifier] ?? s.services[identifier];
  if (!unit) {
    die(
      `--share-redis-with: không tìm thấy app/service '${identifier}' trong registry (${STATE_PATH}).\n` +
        `  Xem danh sách: napp app list · napp service list`
    );
  }
  if (unit.redisDbIndex === undefined) {
    die(
      `--share-redis-with: '${identifier}' không được cấp Redis DB nào nên không có gì để dùng chung.\n` +
        `  Hãy tạo nó với --redis, hoặc chỉ định thẳng --redis-db <n>.`
    );
  }
  return unit.redisDbIndex;
}

/**
 * Một đơn vị napp đang quản lý, tra bằng domain (app web) HOẶC name (service).
 * `root` là gốc mã nguồn của nó — cũng chính là thứ cần cấp quyền ghi cho
 * worker mượn user (xem ServiceRecord.writePaths).
 */
export interface UnitRef {
  kind: "app" | "service";
  id: string; // domain hoặc name
  user: string;
  root: string;
  redisDbIndex?: number;
}

export function findUnit(identifier: string): UnitRef | undefined {
  const s = loadState();
  const app = s.apps[identifier];
  if (app) return { kind: "app", id: app.domain, user: app.user, root: app.webRoot, redisDbIndex: app.redisDbIndex };
  const svc = s.services[identifier];
  if (svc) return { kind: "service", id: svc.name, user: svc.user, root: svc.workDir, redisDbIndex: svc.redisDbIndex };
  return undefined;
}

/**
 * Các service đang MƯỢN user của đơn vị `identifier` (hoặc mượn đúng user đó).
 *
 * Dùng để chặn `napp app remove --source` xoá mất user mà worker đang chạy
 * bằng: user biến mất thì unit của worker chết ngay ở bước khởi động, và lỗi
 * đó không liên quan gì tới lệnh vừa gõ nên rất khó lần ra.
 */
export function servicesRunningAs(identifier: string, user?: string): ServiceRecord[] {
  return Object.values(loadState().services).filter((s) => s.runAsUnit === identifier || (user !== undefined && s.runAsUnit !== undefined && s.user === user));
}

export function slugFor(domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[.-]/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return slug.slice(0, 24);
}

export function userFor(domain: string): string {
  return (USER_PREFIX + slugFor(domain)).slice(0, 32);
}

export function serviceNameFor(domain: string): string {
  return `napp-${slugFor(domain)}`;
}

// --- Background service (chạy ngầm) --------------------------------------
// Namespace TÁCH BIỆT với web app: dù slug của một service trùng slug của một
// domain, user hệ thống và tên unit systemd vẫn khác nhau -> không tranh chấp.
export function serviceUserFor(name: string): string {
  return (SERVICE_USER_PREFIX + slugFor(name)).slice(0, 32);
}

export function svcSystemdName(name: string): string {
  return `napp-svc-${slugFor(name)}`;
}

// Thư mục mã nguồn của background service: /var/www/<name>-service.
// Chỉ dùng khi TẠO MỚI — các lệnh khác luôn đọc `workDir` đã lưu trong registry
// nên service tạo bởi bản napp cũ (ở /srv/napp/<name>) vẫn chạy đúng chỗ cũ.
export function serviceWorkDirFor(name: string): string {
  return `${WWW_ROOT}/${name}${SERVICE_DIR_SUFFIX}`;
}

export function getService(name: string): ServiceRecord | undefined {
  return loadState().services[name];
}

export function requireService(name: string): ServiceRecord {
  const svc = getService(name);
  if (!svc) {
    die(
      `Không tìm thấy background service '${name}' trong registry (${STATE_PATH}).\n` +
        `  Chạy 'napp service list' để xem danh sách, hoặc 'napp service create ${name} ...' để tạo mới.`
    );
  }
  return svc;
}

export function upsertService(svc: ServiceRecord): void {
  const s = loadState();
  s.services[svc.name] = svc;
  if (svc.port !== undefined && !s.usedPorts.includes(svc.port)) s.usedPorts.push(svc.port);
  if (svc.redisDbIndex !== undefined && !s.usedRedisDb.includes(svc.redisDbIndex)) {
    s.usedRedisDb.push(svc.redisDbIndex);
  }
  saveState(s);
}

export function removeService(name: string): ServiceRecord | undefined {
  const s = loadState();
  const svc = s.services[name];
  if (!svc) return undefined;
  delete s.services[name];
  if (svc.port !== undefined) s.usedPorts = s.usedPorts.filter((p) => p !== svc.port);
  releaseRedisDbIfUnused(s, svc.redisDbIndex);
  saveState(s);
  return svc;
}

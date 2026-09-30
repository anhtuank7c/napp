import { existsSync, rmSync, readFileSync } from "node:fs";
import { execCapture, runCmd, runAs, ensureDir, requireRoot, commandExists, writeFile, appendFile } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { validateDomain, validatePort, validateRepoUrl, validateBranch, validateEnvKey } from "../lib/validate";
import {
  AppRecord,
  ServiceRecord,
  Runtime,
  PackageManager,
  getApp,
  requireApp,
  upsertApp,
  removeApp as removeAppFromState,
  allocatePort,
  resolveRedisDb,
  redisDbOf,
  userFor,
  serviceNameFor,
  svcSystemdName,
  slugFor,
  servicesRunningAs,
  WWW_ROOT,
  NGINX_AVAILABLE,
  NGINX_ENABLED,
  SYSTEMD_DIR,
  loadState,
} from "../lib/state";
import { acquireLock } from "../lib/lock";
import { resolveEngine, driverFor, unitEngine, activeEngines, type DbEngine } from "../lib/db";
import { mergeEnvFile } from "../lib/envfile";
import { renderAppNginxConf, appLocationsPath } from "../templates/nginx";
import { writeAppLocationsConf, hintCustomLocations, injectLocationsInclude } from "../lib/locationsfile";
import { ensureNappProxyConf } from "./nginx";
import { renderAppSystemdService, renderServiceSystemdService, execStartLine, unitWorkDir } from "../templates/systemd";
import { writeManagedUnit, patchUnitHeap, patchUnitPriority, type UnitWriteResult } from "../lib/unitfile";
import { detectHardware, detectResourceControl } from "../lib/hardware";
import { nodeHeapPlan, serviceMemoryHighMB, CPU_WEIGHT_WEB, CPU_WEIGHT_SERVICE, IO_WEIGHT_WEB, IO_WEIGHT_SERVICE, type NodeHeapPlan, type UnitMix } from "../templates/tuning";
import { ipv6Available } from "../lib/network";
import { GIT_NONINTERACTIVE_ENV, prepareRepoAuth, setupRepoAuth } from "../lib/repo";
import { detectStaticLayout, detectUploadDir, parseStaticAlias, staticSetCommand, type StaticAlias, type StaticSuggestion } from "../lib/framework";
import { appServePaths, ensureNginxCanServe } from "../lib/staticaccess";
import { defaultPackageManager, defaultInstallCmd, defaultStartCmd, ensurePackageManager, ensureRuntime } from "../lib/provision";

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
  dbEngine?: string; // engine cho --db (bỏ trống = engine mặc định / engine duy nhất đang có)
  redis: boolean;
  redisDb?: number; // index cụ thể (dùng chung keyspace với đơn vị khác)
  shareRedisWith?: string; // domain/name của đơn vị muốn dùng chung Redis DB
  env: string[]; // "KEY=VALUE"
  token?: string; // Personal Access Token để clone repo PRIVATE qua HTTPS
  sshKey?: string; // đường dẫn deploy key (SSH private key) để clone repo PRIVATE qua SSH
  appDir?: string; // monorepo: thư mục con chứa app, tương đối so với webRoot
  maxBody?: string; // client_max_body_size của nginx
  staticRoot?: string; // thư mục asset build để nginx trả thẳng
  staticPrefix?: string[]; // tiền tố URL phục vụ từ staticRoot
  staticAlias?: string[]; // "<tiền-tố-URL>=<thư-mục>" — khi URL và tên thư mục khác nhau
  autoStatic?: boolean; // tự áp cấu hình tĩnh theo framework nhận diện được
  uploadDir?: string; // thư mục file tải lên lúc chạy
  uploadPrefix?: string; // tiền tố URL của thư mục trên
  hotlinkProtect?: boolean; // chỉ cho nhúng ảnh từ domain của site
  hotlinkStrict?: boolean; // bỏ 'none'/'blocked' khỏi valid_referers
  hotlinkAllow?: string[]; // domain ngoài cũng được phép nhúng
  addressHeader?: boolean; // đặt ADDRESS_HEADER/XFF_DEPTH cho adapter-node
}

/** Chuyển '--static-alias <prefix>=<dir>' thành bản ghi, chết sớm nếu sai dạng. */
function resolveStaticAliases(items?: string[]): StaticAlias[] {
  const out: StaticAlias[] = [];
  for (const item of items ?? []) {
    const { value, error } = parseStaticAlias(item);
    if (error) die(error);
    out.push(value!);
  }
  return out;
}

/** Mọi tiền tố URL mà một gợi ý sẽ chiếm — gộp cả hai cơ chế root và alias. */
function suggestedPrefixes(s: StaticSuggestion): string[] {
  return [...s.staticPrefixes, ...s.staticAliases.map((a) => a.prefix)];
}

/**
 * In kết quả nhận diện framework.
 *
 * CỐ Ý in cả khi KHÔNG áp: giá trị lớn nhất của tính năng này không nằm ở chỗ
 * tự cấu hình giúp, mà ở chỗ người dùng biết rằng có một cấu hình đáng bật và
 * biết chính xác câu lệnh để bật. Một app chạy chậm vì đẩy hết asset qua Node
 * KHÔNG có triệu chứng nào ngoài "hơi giựt" — không log, không lỗi.
 */
function reportStaticDetection(domain: string, s: StaticSuggestion, applied: boolean, autoStatic: boolean): void {
  const prefixes = suggestedPrefixes(s).join(" ");
  if (applied) {
    ok(`Nhận diện ${s.framework} → nginx trả thẳng ${prefixes} (không qua Node).`);
    info(`  Căn cứ: có thư mục ${s.evidence}`);
    if (s.note) warn(`  LƯU Ý: ${s.note}`);
    return;
  }

  info(`Nhận diện ${s.framework} (căn cứ: có thư mục ${s.evidence}).`);
  if (s.risky) {
    warn(
      `napp KHÔNG tự áp cấu hình này${autoStatic ? " dù bạn đã truyền --auto-static" : ""}: tiền tố '${prefixes}' không phải namespace riêng của framework.\n` +
        `  'location ^~' thắng cả route regex lẫn proxy_pass, nên nếu app có route thật ở đó thì route ấy chết hẳn bằng 404.`
    );
  } else if (!autoStatic) {
    info(`  Hiện MỌI file .js/.css/.woff2 đều đi qua tiến trình Node — thêm --auto-static lúc tạo app để napp tự bật.`);
  }
  info(`  Bật bằng: ${staticSetCommand(domain, s)}`);
  if (s.note) warn(`  LƯU Ý: ${s.note}`);
}

/**
 * Nói RÕ lớp chặn hotlink nào đang thực sự hoạt động.
 *
 * Quan trọng vì hai lớp có sức mạnh rất khác nhau, mà nhìn cấu hình thì không
 * thấy: `valid_referers` dựa trên header do CHÍNH TRANG NHÚNG khai báo nên chỉ
 * là rào cản tuỳ tiện, còn CORP do trình duyệt người xem thực thi nên trang
 * nhúng không lách được. Người dùng cần biết mình đang có cái nào.
 */
function reportHotlink(app: AppRecord): void {
  const allow = app.hotlinkAllow ?? [];
  if (allow.length === 0) {
    ok(`• Chặn hotlink: Cross-Origin-Resource-Policy=same-site (trình duyệt thực thi, trang nhúng KHÔNG lách được) + kiểm tra Referer.`);
  } else {
    // CORP không có danh sách cho phép theo domain — phát ra là chặn đúng những
    // đối tác vừa được cho phép, và ảnh vỡ ở phía họ mà không ai báo.
    warn(
      `• Chặn hotlink: CHỈ còn kiểm tra Referer, KHÔNG có CORP.\n` +
        `  Vì --hotlink-allow đang cho phép domain ngoài (${allow.join(", ")}), mà CORP chỉ có same-origin/same-site/cross-origin —\n` +
        `  không diễn đạt được danh sách cho phép. Bật CORP ở đây sẽ chặn đúng các domain bạn vừa cho phép.\n` +
        `  Referer do CHÍNH trang nhúng khai báo: một thẻ <meta name="referrer" content="no-referrer"> là đi qua.\n` +
        `  Cần chặn thật mà vẫn cho đối tác nhúng: dùng URL ký (nginx secure_link) hoặc bật ở tầng CDN.`
    );
  }
  if (app.hotlinkStrict) {
    warn(`  --hotlink-strict đang BẬT: link chia sẻ (Facebook, Zalo, Telegram) sẽ MẤT ảnh preview, và người dùng sau proxy công ty có thể bị 403.`);
  }
}

// Render lại TOÀN BỘ unit của một app web từ registry, giữ nguyên các directive
// người dùng đã sửa tay (xem lib/unitfile). Dùng khi cấu hình trong registry đổi
// (tạo app, đổi user/thư mục ghi) — KHÔNG dùng cho việc chỉ đổi con số heap.
/**
 * NODE_OPTIONS napp đặt làm MẶC ĐỊNH cho một đơn vị.
 *
 * Đặt TRƯỚC EnvironmentFile trong unit, nên '.env' của app vẫn ghi đè được —
 * đó là chủ đích. Hệ quả cần nhớ: nếu app khai NODE_OPTIONS trong .env thì mọi
 * cờ ở đây IM LẶNG mất tác dụng, kể cả cờ chụp heap. 'napp mem snapshot' vì thế
 * đọc /proc/<pid>/environ để biết cái gì THẬT SỰ đang chạy.
 */
export function nodeOptionsFor(rec: { nodeRuntime: AppRecord["nodeRuntime"]; leakGuard?: boolean }, heapMB: number): string | undefined {
  // bun dùng JavaScriptCore — không hiểu cờ heap lẫn cờ heapsnapshot của V8.
  if (rec.nodeRuntime !== "node") return undefined;
  const flags = [`--max-old-space-size=${heapMB}`];
  if (rec.leakGuard) flags.push("--heapsnapshot-signal=SIGUSR2", "--heapsnapshot-near-heap-limit=1");
  return flags.join(" ");
}

export function writeAppUnit(app: AppRecord, heapMB: number, authoritative: string[] = []): void {
  const nodeOptions = nodeOptionsFor(app, heapMB);
  const path = `${SYSTEMD_DIR}/${serviceNameFor(app.domain)}.service`;
  reportUnitWrite(path, writeManagedUnit(path, renderAppSystemdService(app, execStartLine(app.startCmd), { nodeOptions }), { authoritative }));
}

/** Như writeAppUnit nhưng cho background service (kèm MemoryHigh — xem dưới). */
export function writeServiceUnit(svc: ServiceRecord, heapMB: number, authoritative: string[] = []): void {
  const nodeOptions = nodeOptionsFor(svc, heapMB);
  const path = `${SYSTEMD_DIR}/${svcSystemdName(svc.name)}.service`;
  // MemoryHigh CHỈ tồn tại ở cgroup v2. Ghi nó ra trên máy cgroup v1 (Ubuntu
  // 20.04) thì systemd nhận directive nhưng kernel bỏ qua — một dòng cấu hình
  // trông như đang bảo vệ cái gì đó mà thực ra không. Thà không ghi.
  //
  // Dựa trên heapMB (phần ngân sách RAM của đơn vị này) nên áp được cho CẢ bun:
  // đây là cơ chế cgroup, không liên quan tới runtime.
  const memoryHighMB = detectResourceControl().cgroupV2 ? serviceMemoryHighMB(heapMB) : undefined;
  reportUnitWrite(
    path,
    writeManagedUnit(path, renderServiceSystemdService(svc, execStartLine(svc.startCmd), { nodeOptions, memoryHighMB }), { authoritative })
  );
}

// Người dùng phải BIẾT napp vừa giữ lại (hoặc buộc phải ghi đè) directive nào —
// im lặng ở đây là cách nhanh nhất để tưởng nhầm bản sửa tay đã mất.
function reportUnitWrite(path: string, res: UnitWriteResult): void {
  if (res.preserved.length > 0) info(`${path}: giữ nguyên directive bạn đã sửa (${res.preserved.join(", ")}).`);
  if (res.overridden.length > 0) {
    warn(
      `${path}: napp buộc phải đặt lại ${res.overridden.join(", ")} theo cấu hình mới trong registry — ` +
        `bản sửa tay của bạn ở các directive này KHÔNG còn.`
    );
  }
}

/** Số đơn vị node trên máy, TÁCH theo loại (mẫu số có trọng số cần biết cả hai). */
export function unitMix(delta: Partial<UnitMix> = {}): UnitMix {
  const s = loadState();
  return {
    webApps: Object.keys(s.apps).length + (delta.webApps ?? 0),
    services: Object.keys(s.services).length + (delta.services ?? 0),
  };
}

/**
 * Kế hoạch heap hiện tại: web app được phần lớn hơn background service.
 *
 * Trọng số lấy từ registry (`serviceHeapWeight`) chứ không phải hằng số, để
 * `tune apply --service-weight` còn có hiệu lực ở những lần tạo/xoá app sau —
 * nếu đọc hằng số thì lần `app create` kế tiếp sẽ lật lại lựa chọn của người
 * dùng mà không ai thấy.
 */
export function currentHeapPlan(delta: Partial<UnitMix> = {}): NodeHeapPlan {
  const mix = unitMix(delta);
  return nodeHeapPlan(detectHardware(), mix, { serviceWeight: loadState().serviceHeapWeight, dbEngines: activeEngines().length });
}

/** Directive ưu tiên tài nguyên cho một unit, theo loại. MemoryHigh chỉ cho service. */
export function priorityDirectivesFor(kind: "web" | "service", heapMB: number): Record<string, string> {
  if (kind === "web") return { CPUWeight: String(CPU_WEIGHT_WEB), IOWeight: String(IO_WEIGHT_WEB) };
  const out: Record<string, string> = { CPUWeight: String(CPU_WEIGHT_SERVICE), IOWeight: String(IO_WEIGHT_SERVICE) };
  // Bỏ hẳn khoá MemoryHigh trên cgroup v1 -> patchUnitPriority không đụng tới nó.
  if (detectResourceControl().cgroupV2) out.MemoryHigh = `${serviceMemoryHighMB(heapMB)}M`;
  return out;
}

/** In kết quả cân đối. Dùng chung cho mọi chỗ gọi applyNodeHeaps. */
export function reportBalance(r: UnitBalanceResult): void {
  info(
    `Ngân sách RAM cho node: web app ${r.webMB} MB · background service ${r.serviceMB} MB ` +
      `(trọng số service ${r.serviceWeight}) — ${r.totalUnits} đơn vị.`
  );
  if (r.heapChanged.length > 0) info(`  Đã restart để áp heap mới: ${r.heapChanged.join(", ")}`);
  if (r.priorityChanged.length > 0) {
    info(`  Đã cập nhật ưu tiên CPU/IO (daemon-reload áp ngay, KHÔNG cần restart): ${r.priorityChanged.join(", ")}`);
  }
}

export interface UnitBalanceResult extends NodeHeapPlan {
  /** Unit đã đổi heap -> BẮT BUỘC restart (NODE_OPTIONS chỉ đọc lúc khởi động). */
  heapChanged: string[];
  /** Unit chỉ đổi ưu tiên CPU/IO/MemoryHigh -> daemon-reload là áp được, không cần restart. */
  priorityChanged: string[];
}

/**
 * Cân đối heap V8 + ƯU TIÊN TÀI NGUYÊN giữa TẤT CẢ đơn vị node trên máy.
 * Gọi khi số app/service thay đổi (tạo/xoá) và khi `napp tune apply`.
 *
 * WEB APP ĐƯỢC PHẦN LỚN HƠN background service — cả heap lẫn CPUWeight/IOWeight.
 * Lý do đầy đủ nằm ở templates/tuning.ts; tóm tắt: chỉ một trong hai loại đó
 * ảnh hưởng tới độ trễ mà người dùng thật cảm nhận được.
 *
 * CHỈ SỬA ĐÚNG NHỮNG DÒNG CẦN SỬA: con số trong '--max-old-space-size', và các
 * dòng CPUWeight/IOWeight/MemoryHigh. Không render lại unit, không đụng
 * ExecStart / StandardOutput / User / Group hay bất kỳ dòng nào khác — đây là
 * đường chạy ngầm và chạy thường xuyên nhất, render lại cả file ở đây là cách
 * chắc chắn nhất để một ngày nào đó thổi bay cấu hình sửa tay.
 *
 * Ưu tiên tài nguyên được vá cho MỌI runtime, kể cả bun: CPUWeight là cơ chế
 * cgroup của kernel, không liên quan gì tới V8 (khác heap — thứ chỉ có nghĩa
 * với node).
 *
 * skipRestartFor: bỏ qua restart đơn vị có định danh này (domain HOẶC name) — dùng
 * khi đơn vị vừa tạo đã chạy với cấu hình đúng rồi, chỉ cần áp cho các đơn vị cũ.
 */
export function applyNodeHeaps(opts: { restart: boolean; skipRestartFor?: string } = { restart: false }): UnitBalanceResult {
  const s = loadState();
  const apps = Object.values(s.apps);
  const services = Object.values(s.services);
  const plan = nodeHeapPlan(
    detectHardware(),
    { webApps: apps.length, services: services.length },
    { serviceWeight: s.serviceHeapWeight, dbEngines: activeEngines().length }
  );
  const heapChanged: string[] = [];
  const priorityChanged: string[] = [];
  if (apps.length + services.length === 0) return { ...plan, heapChanged, priorityChanged };

  const sync = (unit: string, id: string, kind: "web" | "service", heapMB: number, isNode: boolean, create: () => void) => {
    const path = `${SYSTEMD_DIR}/${unit}.service`;
    const skip = id === opts.skipRestartFor;
    // bun dùng JavaScriptCore, không hiểu cờ heap của V8 — không có gì để vá,
    // nhưng unit vẫn phải tồn tại và vẫn cần ưu tiên tài nguyên.
    if (isNode) {
      if (patchHeapOrCreate(path, heapMB, create) && !skip) heapChanged.push(unit);
    } else if (!existsSync(path)) {
      warn(`Không tìm thấy ${path} — dựng lại unit từ registry.`);
      create();
      if (!skip) heapChanged.push(unit);
    }
    const pr = patchUnitPriority(path, priorityDirectivesFor(kind, heapMB));
    if (pr.preserved.length > 0) info(`${path}: giữ nguyên ${pr.preserved.join(", ")} bạn đã khoá bằng '# napp-preserve:'.`);
    if (pr.changed && !heapChanged.includes(unit) && !skip) priorityChanged.push(unit);
  };

  for (const app of apps) {
    sync(serviceNameFor(app.domain), app.domain, "web", plan.webMB, app.nodeRuntime === "node", () => writeAppUnit(app, plan.webMB));
  }
  for (const svc of services) {
    sync(svcSystemdName(svc.name), svc.name, "service", plan.serviceMB, svc.nodeRuntime === "node", () => writeServiceUnit(svc, plan.serviceMB));
  }

  if (heapChanged.length + priorityChanged.length === 0) return { ...plan, heapChanged, priorityChanged };

  // daemon-reload áp được CPUWeight/IOWeight/MemoryHigh cho unit ĐANG CHẠY
  // (systemd dựng lại thuộc tính cgroup khi nạp lại). Heap thì KHÔNG: NODE_OPTIONS
  // chỉ được đọc lúc tiến trình khởi động, nên đổi heap là phải restart thật.
  runCmd("systemctl", ["daemon-reload"]);
  if (opts.restart) {
    for (const unit of heapChanged) runCmd("systemctl", ["restart", unit], { silentFail: true });
  }
  return { ...plan, heapChanged, priorityChanged };
}

// Render lại unit của MỌI app/service từ registry — dùng khi cần đẩy phần
// template mới (hardening, ReadWritePaths, thứ tự biến môi trường) xuống cả
// những unit tạo từ bản napp cũ. KHÔNG nằm trong đường chạy cân đối heap: đây là
// bước có thể đổi nhiều dòng nên phải do người dùng chủ động gọi
// (`napp tune apply --sync-units`). Directive người dùng sửa tay vẫn được giữ.
export function syncAllUnits(opts: { restart: boolean }): NodeHeapPlan {
  const s = loadState();
  const apps = Object.values(s.apps);
  const services = Object.values(s.services);
  const plan = nodeHeapPlan(
    detectHardware(),
    { webApps: apps.length, services: services.length },
    { serviceWeight: s.serviceHeapWeight, dbEngines: activeEngines().length }
  );
  if (apps.length + services.length === 0) return plan;
  for (const app of apps) writeAppUnit(app, plan.webMB);
  for (const svc of services) writeServiceUnit(svc, plan.serviceMB);
  runCmd("systemctl", ["daemon-reload"]);
  if (opts.restart) {
    for (const app of apps) runCmd("systemctl", ["restart", serviceNameFor(app.domain)], { silentFail: true });
    for (const svc of services) runCmd("systemctl", ["restart", svcSystemdName(svc.name)], { silentFail: true });
  }
  return plan;
}

// Vá heap cho MỘT unit. Unit không tồn tại (registry và hệ thống lệch nhau, ví
// dụ ai đó xoá tay file) thì mới dựng lại từ template. Trả về true nếu file đã đổi.
function patchHeapOrCreate(path: string, heapMB: number, create: () => void): boolean {
  if (!existsSync(path)) {
    warn(`Không tìm thấy ${path} — dựng lại unit từ registry.`);
    create();
    return true;
  }
  const res = patchUnitHeap(path, heapMB);
  if (res.note) warn(`${path}: ${res.note}`);
  return res.changed;
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

  // --- xác thực repo private (không tương tác) ---
  // Fail sớm (trước khi tạo tài nguyên, khỏi rollback). Nếu có --ssh-key thì sau
  // lệnh này opts.sshKey là NỘI DUNG key đã chuẩn hoá (không còn là đường dẫn).
  prepareRepoAuth(opts);

  const user = userFor(domain);
  const webRoot = `${WWW_ROOT}/${domain}`;
  const port = allocatePort(opts.port);
  validatePort(port);
  const serviceName = serviceNameFor(domain);

  assertSiteAbsent(domain, user, port);

  const pm: PackageManager = opts.packageManager ?? defaultPackageManager(opts.runtime);

  // Runtime engine phải chạy được (app node chạy bằng node; app bun chạy bằng bun).
  ensureRuntime(opts.runtime);
  // Trình quản lý gói phải dùng được Ở MỨC HỆ THỐNG (app user + systemd đều thấy).
  // Tự cài pnpm/yarn qua npm nếu thiếu. Làm TRƯỚC khi tạo tài nguyên để fail sớm,
  // không phải tạo rồi rollback.
  ensurePackageManager(pm);
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  // Chọn engine TRƯỚC khi tạo tài nguyên: nhiều engine mà không chỉ định thì
  // dừng ở đây, không phải tạo nửa chừng rồi rollback.
  const dbEngine: DbEngine | undefined = opts.db ? resolveEngine(opts.dbEngine) : undefined;

  const release = acquireLock(domain);
  let rollbackActive = true;
  let dbCreatedName: string | undefined; // set ngay sau khi createDatabase() thành công, để rollback biết cần xoá
  const rollback = () => {
    if (!rollbackActive) return;
    warn("Tạo app thất bại — đang hoàn tác các thay đổi đã thực hiện...");
    try {
      runCmd("rm", ["-f", `${NGINX_ENABLED}/${domain}.conf`, `${NGINX_AVAILABLE}/${domain}.conf`, appLocationsPath(domain)], { silentFail: true });
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
          driverFor(dbEngine!).drop(dbCreatedName, dbCreatedName);
        } catch {
          /* đã cảnh báo bên trong drop()/runCmd nếu có lỗi; không chặn phần rollback còn lại */
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
      if (opts.token || opts.sshKey) setupRepoAuth(user, opts.repo, opts);
      info(`Đang clone ${opts.repo} (branch ${opts.branch})...`);
      const clone = runAs(user, "git", ["clone", "--branch", opts.branch, "--depth", "1", opts.repo, webRoot], {
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
const html = \`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${domain}</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
      box-sizing: border-box;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: center;
    }
  </style>
</head>
<body>
  <p>Trang web đang trong quá trình phát triển. Vui lòng quay lại sau.</p>
</body>
</html>\`;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
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
    if (dbEngine) {
      dbInfo = driverFor(dbEngine).create(user, user);
      dbCreatedName = dbInfo.name;
      ok(`Đã tạo database ${driverFor(dbEngine).label} '${dbInfo.name}' + user CSDL '${dbInfo.user}'`);
    }

    // --- redis (tuỳ chọn) ---
    let redisDbIndex: number | undefined;
    if (opts.redis || opts.redisDb !== undefined || opts.shareRedisWith) {
      const preferred = opts.shareRedisWith ? redisDbOf(opts.shareRedisWith) : opts.redisDb;
      redisDbIndex = resolveRedisDb(preferred);
      if (redisDbIndex === undefined) {
        warn("Đã hết database Redis riêng (0-15). Bỏ qua cấp DB riêng — hãy dùng key-prefix trong app thay vì DB riêng.");
      } else if (preferred !== undefined) {
        ok(`Dùng CHUNG Redis DB #${redisDbIndex}${opts.shareRedisWith ? ` với '${opts.shareRedisWith}'` : ""}`);
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
    };

    // ADDRESS_HEADER + XFF_DEPTH: CHỈ đặt khi được yêu cầu (--address-header).
    //
    // Chúng đổi thứ mà `getClientAddress()` của adapter-node trả về: từ ĐỊA CHỈ
    // SOCKET của bên gọi sang một giá trị PARSE RA TỪ HEADER. Tiện cho app chỉ
    // cần "IP khách là gì", nhưng phá app tự làm lấy việc đó — cách làm chuẩn là
    // lấy socket peer, đối chiếu với danh sách proxy tin cậy, RỒI mới tin header.
    // Đặt ADDRESS_HEADER là đưa cho phép kiểm tra ấy một giá trị do client cung
    // cấp: nó không bao giờ khớp, app spam log kiểu "ignoring forwarding headers
    // from untrusted peer ..." và rơi về tin bất cứ thứ gì XFF_DEPTH chọn.
    //
    // IP thường vẫn ra ĐÚNG, và đó mới là chỗ nguy hiểm: tính đúng đắn khi đó
    // phụ thuộc hoàn toàn vào XFF_DEPTH khớp với số hop THẬT. Thêm một hop sau
    // này (CDN, load balancer thứ hai) là nó lặng lẽ đọc phải một mục CLIENT
    // GIẢ MẠO ĐƯỢC — trong khi phép kiểm tra lẽ ra bắt được đã bị vô hiệu từ
    // trước. Giá trị đó thường là khoá của rate limiter, nên hỏng ở đây nghĩa là
    // đăng nhập sai không giới hạn, không phải một dòng log sai.
    //
    // Không đặt thì `getClientAddress()` trả 127.0.0.1 — sai một cách LỘ LIỄU,
    // dễ phát hiện, thay vì sai một cách im lặng.
    if (opts.addressHeader) {
      envUpdates.ADDRESS_HEADER = "x-forwarded-for";
      // Đếm từ phải qua trong X-Forwarded-For. 1 = chỉ nginx đứng trước.
      // LƯU Ý: khi nginx đã bật Cloudflare real-IP (napp cloudflare sync),
      // $remote_addr ĐÃ LÀ IP khách thật nên $proxy_add_x_forwarded_for nối
      // thêm chính nó — vẫn là 1, KHÔNG phải 2. Chỉ tăng khi thực sự có thêm
      // một proxy mà nginx không khôi phục real-IP giúp.
      envUpdates.XFF_DEPTH = "1";
    }
    if (dbInfo && dbEngine) Object.assign(envUpdates, driverFor(dbEngine).envFor(dbInfo));
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
    // `.env` phải nằm ĐÚNG chỗ systemd đọc (EnvironmentFile = <workDir>/.env).
    // Với monorepo, workDir là thư mục con — ghi .env ở gốc repo thì unit sẽ
    // không thấy, và vì EnvironmentFile có tiền tố `-` (bỏ qua nếu thiếu) nên
    // app khởi động RỖNG biến môi trường mà không có lỗi nào được in ra.
    const appWorkDir = unitWorkDir(webRoot, opts.appDir);
    if (appWorkDir !== webRoot) ensureDir(appWorkDir);
    const envPath = `${appWorkDir}/.env`;
    mergeEnvFile(envPath, envUpdates, 0o600);
    // Khối GỢI Ý (comment) về CSRF của SvelteKit — mergeEnvFile chỉ ghi KEY=VALUE
    // và lược bỏ comment, nên phải append riêng ở đây. Chỉ có trong .env "mẫu"
    // lúc tạo app; lần `napp app env set` sau sẽ ghi lại file và bỏ khối này —
    // không sao, nó chỉ là hướng dẫn, PROTOCOL_HEADER/HOST_HEADER ở trên mới là
    // phần thực sự làm CSRF chạy đúng.
    appendFile(
      envPath,
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
    runCmd("chown", [`${user}:${user}`, envPath]);
    ok("Đã ghi cấu hình vào .env (quyền 600, chỉ user của app đọc được)");

    // --- phân quyền chuẩn ---
    runCmd("chown", ["-R", `${user}:${user}`, webRoot]);
    runCmd("find", [webRoot, "-type", "d", "-exec", "chmod", "750", "{}", "+"]);
    runCmd("find", [webRoot, "-type", "f", "-exec", "chmod", "640", "{}", "+"]);
    runCmd("chmod", ["600", envPath]);

    // --- asset tĩnh: nhận diện framework từ THƯ MỤC BUILD (xem lib/framework.ts) ---
    // Chạy Ở ĐÂY vì đây là điểm sớm nhất có đủ hai điều kiện: build đã xong (nên
    // thư mục output có thật) và bản ghi chưa dựng (nên còn kịp đưa vào).
    const explicitStatic =
      opts.staticRoot !== undefined || (opts.staticPrefix?.length ?? 0) > 0 || (opts.staticAlias?.length ?? 0) > 0;
    let staticRoot = opts.staticRoot;
    let staticPrefixes = (opts.staticPrefix?.length ?? 0) > 0 ? opts.staticPrefix : undefined;
    let staticAliases = resolveStaticAliases(opts.staticAlias);
    let framework: string | undefined;

    const detected = detectStaticLayout(appWorkDir);
    if (detected) {
      framework = detected.framework;
      let applied = false;
      // Cờ người dùng truyền tay LUÔN THẮNG nhận diện: họ biết app của mình,
      // bảng luật thì chỉ đoán từ tên thư mục.
      if (explicitStatic) {
        info(`Nhận diện ${detected.framework}, nhưng bạn đã truyền cấu hình tĩnh riêng — giữ nguyên bản của bạn.`);
      } else if (opts.autoStatic && !detected.risky) {
        staticRoot = detected.staticRoot;
        staticPrefixes = detected.staticPrefixes.length > 0 ? detected.staticPrefixes : undefined;
        staticAliases = detected.staticAliases;
        applied = true;
      }
      if (!explicitStatic) reportStaticDetection(domain, detected, applied, opts.autoStatic ?? false);
    } else if (opts.autoStatic) {
      warn(
        `--auto-static: không nhận ra bố cục asset nào trong ${appWorkDir}.\n` +
          `  Nếu app chưa build (thiếu --build-cmd) thì chưa có gì trên đĩa để phục vụ. ` +
          `Bố cục lạ thì cấu hình tay bằng 'napp app set ${domain} --static-root ... --static-prefix ...'.`
      );
    }

    // Thư mục file tải lên — nhận diện TÁCH RIÊNG với asset build, vì nó không
    // phụ thuộc framework và hỏng theo một kiểu hoàn toàn khác (xem detectUploadDir).
    let uploadDir = opts.uploadDir;
    let uploadPrefix = opts.uploadPrefix;
    if (uploadDir === undefined) {
      const upload = detectUploadDir(appWorkDir);
      if (upload) {
        if (opts.autoStatic) {
          uploadDir = upload.dir;
          // Kèm tiền tố, vì mặc định của renderer là '/uploads/' — thư mục tên
          // 'upload' (số ít) sẽ bị phục vụ ở sai URL nếu bỏ dòng này.
          uploadPrefix = upload.prefix;
          ok(`Nhận diện thư mục tải lên ${upload.dir} → nginx phục vụ tại ${upload.prefix}`);
          info(`  Nó nằm trong '${upload.publicRoot}/' nên vốn đã công khai ở mọi bản build — cấu hình này không mở thêm gì.`);
        } else {
          info(`Thấy thư mục tải lên ${upload.dir} nhưng CHƯA được nginx phục vụ.`);
          info(
            `  File tải lên SAU lần build gần nhất sẽ trả 404 (build chỉ sao chép '${upload.publicRoot}/' vào output MỘT LẦN), ` +
              `rồi tự hiện ra sau lần deploy kế tiếp — rất giống lỗi chập chờn.`
          );
          info(`  Bật bằng: sudo napp app set ${domain} --upload-dir ${upload.dir}`);
        }
      }
    }

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
      dbEngine: dbInfo ? dbEngine : undefined,
      redisDbIndex,
      appDir: opts.appDir,
      maxBodySize: opts.maxBody,
      staticRoot,
      staticPrefixes,
      staticAliases: staticAliases.length > 0 ? staticAliases : undefined,
      framework,
      uploadDir,
      uploadPrefix,
      hotlinkProtect: opts.hotlinkProtect,
      hotlinkStrict: opts.hotlinkStrict,
      hotlinkAllow: opts.hotlinkAllow,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Heap V8 chỉ đặt cho runtime node (bun dùng JSC, không hiểu cờ này). Chia
    // theo TỔNG số ĐƠN VỊ node SAU khi thêm app này; user có thể ghi đè
    // NODE_OPTIONS trong .env.
    //
    // Mẫu số tính CẢ background service — trước đây chỗ này chỉ đếm app web, nên
    // app đầu tiên trên một máy đã có sẵn worker sẽ nhận heap quá lớn (rồi chỉ
    // được sửa lại nếu về sau có app thứ hai kích hoạt applyNodeHeaps).
    const plan = currentHeapPlan({ webApps: 1 });
    const heapMB = plan.webMB;
    // App mới -> unit chưa có, writeAppUnit ghi thẳng bản template. Đi qua nó
    // (thay vì writeFile) để file mang sẵn fingerprint, nhờ đó lần sửa tay đầu
    // tiên của người dùng được nhận ra và giữ lại.
    writeAppUnit(record, heapMB);
    if (opts.runtime === "node") {
      info(
        `NODE_OPTIONS=--max-old-space-size=${heapMB} (web app được phần lớn hơn background service: ` +
          `${plan.webMB} MB so với ${plan.serviceMB} MB; đổi trong .env nếu cần)`
      );
    }
    runCmd("systemctl", ["daemon-reload"]);
    runCmd("systemctl", ["enable", serviceName]);
    runCmd("systemctl", ["restart", serviceName]);
    ok(`Đã tạo và khởi động systemd service '${serviceName}'`);

    // --- nginx vhost (chỉ HTTP; certbot sẽ thêm SSL sau) ---
    // Ghi map dùng chung TRƯỚC: vhost dưới đây tham chiếu $napp_connection_upgrade,
    // thiếu file này thì `nginx -t` sẽ trượt vì biến chưa được định nghĩa.
    ensureNappProxyConf();
    const ngxConf = `${NGINX_AVAILABLE}/${domain}.conf`;
    // PHẢI ghi trước vhost: vhost `include` file này, và nginx TỪ CHỐI KHỞI ĐỘNG
    // nếu include trỏ vào file không tồn tại. Ghi cả khi app không bật tuỳ chọn
    // nào — khi đó file chỉ chứa chú thích.
    writeAppLocationsConf(record);
    writeFile(ngxConf, renderAppNginxConf(record, { ipv6: ipv6Available() }), 0o644);
    runCmd("ln", ["-sf", ngxConf, `${NGINX_ENABLED}/${domain}.conf`]);
    const test = execCapture("nginx", ["-t"]);
    if (test.code !== 0) die(`Kiểm tra cấu hình nginx thất bại:\n${test.stderr}`);
    runCmd("systemctl", ["reload", "nginx"]);
    ok("Đã kích hoạt vhost nginx (chỉ HTTP)");

    upsertApp(record);
    rollbackActive = false;
    release();

    // Quyền đọc cho nginx — CHỈ sau khi app đã an toàn trong registry.
    // Thư mục app là 750 thuộc user riêng, nginx chạy bằng user khác nên không
    // đi xuyên qua được: thiếu bước này thì mọi tiền tố tĩnh vừa cấu hình trả
    // 403 chứ không phải file. Xem lib/staticaccess.ts.
    ensureNginxCanServe(user, appServePaths(record));

    // Cân đối lại heap V8 giữa các app để chia sẻ RAM. App vừa tạo đã chạy với
    // heap đúng rồi nên bỏ qua restart nó; chỉ ghi lại + restart các app CŨ để
    // chúng nhường bớt heap cho app mới (quan trọng trên máy RAM nhỏ).
    const totalUnits = unitMix().webApps + unitMix().services;
    if (totalUnits > 1) reportBalance(applyNodeHeaps({ restart: true, skipRestartFor: domain }));

    console.log();
    console.log("===============================================================");
    ok("Tạo app thành công!");
    console.log(`  Tên miền     : http://${domain}`);
    console.log(`  Mã nguồn     : ${webRoot}`);
    console.log(`  Chạy bằng    : ${user} (systemd: ${serviceName})`);
    console.log(`  Runtime      : ${opts.runtime} · quản lý gói: ${pm}`);
    console.log(`  Cổng nội bộ  : 127.0.0.1:${port} (không public — chỉ nginx proxy vào)`);
    if (dbInfo && dbEngine) {
      console.log(`  Database     : ${driverFor(dbEngine).label} '${dbInfo.name}'  (user: ${dbInfo.user}, mật khẩu + DATABASE_URL trong .env)`);
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
    // Cùng env KHÔNG TƯƠNG TÁC như lúc clone: repo private dùng lại token/deploy
    // key đã lưu trong home của user app; nếu hỏng thì fail rõ ràng, không treo.
    runAs(app.user, "git", ["fetch", "origin", app.branch], { cwd: app.webRoot, env: GIT_NONINTERACTIVE_ENV });
    runAs(app.user, "git", ["reset", "--hard", `origin/${app.branch}`], { cwd: app.webRoot, env: GIT_NONINTERACTIVE_ENV });

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
    runCmd("chmod", ["600", `${unitWorkDir(app.webRoot, app.appDir)}/.env`], { silentFail: true });

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
        `Database và dữ liệu vẫn còn, nhưng muốn dùng lại phải đặt mật khẩu mới cho user CSDL '${app.dbUser ?? app.dbName}' (${driverFor(unitEngine(app)).label}). ` +
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
      runCmd("rm", ["-f", `${NGINX_ENABLED}/${domain}.conf`, `${NGINX_AVAILABLE}/${domain}.conf`, appLocationsPath(domain)], { silentFail: true });
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
      // Worker tạo với '--run-as <domain>' CHẠY BẰNG user này. Xoá user đi thì
      // unit của worker chết ngay ở bước khởi động ("Failed to determine user
      // credentials"), một lỗi không hề nhắc tới app vừa gỡ nên rất khó lần ra.
      const borrowers = servicesRunningAs(app.domain, app.user);
      if (borrowers.length > 0) {
        warn(
          `GIỮ LẠI user hệ thống '${app.user}' — ${borrowers.length} background service đang chạy bằng user này (--run-as):\n` +
            borrowers.map((s) => `  - ${s.name}`).join("\n") +
            `\n  Xoá user đi là các service đó chết ngay lần khởi động sau. Gỡ chúng trước nếu thật sự muốn xoá user:\n` +
            borrowers.map((s) => `    sudo napp service remove ${s.name} --source`).join("\n") +
            `\n  Lưu ý: thư mục ${app.webRoot} vừa xoá cũng nằm trong ReadWritePaths của chúng — systemd TỪ CHỐI khởi động unit khi đường dẫn đó không còn.`
        );
      } else if (execCapture("id", [app.user]).code === 0) {
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
          driverFor(unitEngine(app)).drop(app.dbName, app.dbUser);
          ok(`Đã xoá database '${app.dbName}'.`);
        } catch (e) {
          warn(
            `Không xoá được database '${app.dbName}' (${(e as Error).message}). ` +
              `Các tài nguyên khác đã xử lý xong — hãy tự xoá database này sau bằng 'napp db drop ${app.dbName} --engine ${unitEngine(app)} --yes --user ${app.dbUser ?? app.dbName}'.`
          );
        }
      } else {
        info("App không có database riêng — bỏ qua.");
      }
    } else if (app.dbName) {
      info(`Giữ lại database '${app.dbName}'. Muốn xoá sau: napp db drop ${app.dbName} --engine ${unitEngine(app)} --yes --user ${app.dbUser ?? app.dbName}`);
    }

    removeAppFromState(domain);
    ok(`Đã gỡ app '${domain}' khỏi napp.`);

    // Cân đối lại heap V8 cho các app còn lại — nay được chia phần RAM lớn hơn.
    const mixAfter = unitMix();
    if (mixAfter.webApps + mixAfter.services > 0) reportBalance(applyNodeHeaps({ restart: true }));
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
        app.dbName ? `db=${unitEngine(app)}:${app.dbName} ` : ""
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
  // Cùng đường dẫn systemd đọc — xem chú thích ở cmdAppCreate.
  const appEnv = `${unitWorkDir(app.webRoot, app.appDir)}/.env`;
  mergeEnvFile(appEnv, updates, 0o600);
  runCmd("chown", [`${app.user}:${app.user}`, appEnv]);
  runCmd("chmod", ["600", appEnv]);
  ok(`Đã cập nhật .env cho '${domain}'. Chạy 'napp app restart ${domain}' để áp dụng.`);
}

// --- napp app set --------------------------------------------------------

export interface SetAppOptions {
  staticRoot?: string;
  staticPrefix?: string[];
  staticAlias?: string[];
  autoStatic?: boolean;
  uploadDir?: string;
  uploadPrefix?: string;
  hotlinkProtect?: boolean;
  hotlinkStrict?: boolean;
  hotlinkAllow?: string[];
  maxBody?: string;
  scanBlock?: boolean;
}

/**
 * Đổi cấu hình nginx của một app ĐÃ TẠO.
 *
 * `napp nginx sync` KHÔNG làm được việc này: nó chỉ vá đúng một chuỗi
 * (`Connection "upgrade"`) chứ không render lại vhost — và cố ý như vậy, vì
 * certbot chèn khối SSL thẳng vào vhost nên render lại là xoá HTTPS đang chạy.
 * Nên các tuỳ chọn thêm ở 1.15.0 chỉ áp dụng cho app tạo mới; app đang chạy cần
 * lệnh này.
 *
 * Cách làm: ghi/ghi đè file location riêng của app (napp sở hữu trọn vẹn, không
 * có gì của certbot trong đó), rồi chèn ĐÚNG MỘT dòng `include` vào vhost nếu
 * chưa có. Từ lần sau trở đi chỉ còn ghi lại file include, vhost không bị chạm.
 */
export function cmdAppSet(domain: string, opts: SetAppOptions): void {
  requireRoot();
  validateDomain(domain);
  if (!commandExists("nginx")) die("nginx chưa được cài.");
  const app = requireApp(domain);

  const changed: string[] = [];
  const set = <K extends keyof AppRecord>(key: K, value: AppRecord[K], label: string) => {
    if (value === undefined) return;
    app[key] = value;
    changed.push(label);
  };
  // --auto-static: nhận diện lại TỪ ĐĨA rồi áp — đường dành cho app đã tạo từ
  // trước (bản napp cũ chưa có nhận diện, hoặc lúc tạo app chưa build xong).
  if (opts.autoStatic) {
    const detected = detectStaticLayout(unitWorkDir(app.webRoot, app.appDir));
    if (!detected) {
      die(
        `--auto-static: không nhận ra bố cục asset nào trong ${unitWorkDir(app.webRoot, app.appDir)}.\n` +
          `  App đã build chưa? Bố cục lạ thì cấu hình tay: --static-root <dir> --static-prefix <tiền-tố>`
      );
    }
    if (detected.risky) {
      die(
        `--auto-static: nhận diện ${detected.framework}, nhưng tiền tố '${suggestedPrefixes(detected).join(" ")}' ` +
          `không phải namespace riêng của framework nên napp KHÔNG tự áp.\n` +
          `  'location ^~' thắng cả route regex lẫn proxy_pass — áp nhầm là route thật của app chết hẳn bằng 404.\n` +
          `  Kiểm tra app không dùng tiền tố đó làm route, rồi áp tay:\n    ${staticSetCommand(domain, detected)}`
      );
    }
    set("framework", detected.framework as AppRecord["framework"], `framework=${detected.framework}`);
    // Đặt CẢ BA trường, kể cả về undefined: --auto-static phải cho ra ĐÚNG cấu
    // hình vừa nhận diện, không phải cấu hình đó CHỒNG LÊN cấu hình cũ. Một app
    // từng là Next.js (dùng alias) rồi đổi sang SvelteKit (dùng root) mà chỉ ghi
    // các trường có giá trị thì sẽ giữ lại location alias trỏ vào '.next/static'
    // không còn tồn tại — nginx vẫn nạp được, nên hỏng này im lặng hoàn toàn.
    //
    // Vì thế KHÔNG dùng set(): set() bỏ qua undefined có chủ đích (để cờ CLI
    // không truyền thì không xoá cấu hình cũ). Ở đây undefined lại CÓ NGHĨA —
    // "framework này không dùng cơ chế đó" — nên phải gán thẳng.
    const force = <K extends keyof AppRecord>(key: K, value: AppRecord[K], label: string) => {
      if (JSON.stringify(app[key]) === JSON.stringify(value)) return;
      app[key] = value;
      changed.push(label);
    };
    force("staticRoot", detected.staticRoot as AppRecord["staticRoot"], `static-root=${detected.staticRoot ?? "(bỏ)"}`);
    force(
      "staticPrefixes",
      detected.staticPrefixes.length > 0 ? detected.staticPrefixes : undefined,
      `static-prefix=${detected.staticPrefixes.join(",") || "(bỏ)"}`
    );
    force(
      "staticAliases",
      detected.staticAliases.length > 0 ? detected.staticAliases : undefined,
      `static-alias=${detected.staticAliases.map((a) => a.prefix).join(",") || "(bỏ)"}`
    );
    if (detected.note) warn(`LƯU Ý (${detected.framework}): ${detected.note}`);

    // Thư mục tải lên đi kèm luôn: đây chính là ca đã khiến người dùng phải sửa
    // tay file location (napp không "quên" phục vụ /uploads/ — registry đơn giản
    // là không có uploadDir nào để mà phục vụ). KHÔNG ghi đè nếu app đã có.
    if (!app.uploadDir) {
      const upload = detectUploadDir(unitWorkDir(app.webRoot, app.appDir));
      if (upload) {
        set("uploadDir", upload.dir as AppRecord["uploadDir"], `upload-dir=${upload.dir}`);
        // PHẢI đặt kèm tiền tố: renderAppLocationsConf mặc định '/uploads/', nên
        // thư mục tên 'upload' (số ít) sẽ bị phục vụ ở sai URL nếu bỏ dòng này.
        set("uploadPrefix", upload.prefix as AppRecord["uploadPrefix"], `upload-prefix=${upload.prefix}`);
        info(`Nhận diện thư mục tải lên ${upload.dir} → phục vụ tại ${upload.prefix} (nằm trong '${upload.publicRoot}/' nên vốn đã công khai).`);
      }
    }
  }

  set("staticRoot", opts.staticRoot as AppRecord["staticRoot"], `static-root=${opts.staticRoot}`);
  if ((opts.staticPrefix?.length ?? 0) > 0) set("staticPrefixes", opts.staticPrefix, `static-prefix=${opts.staticPrefix!.join(",")}`);
  if ((opts.staticAlias?.length ?? 0) > 0) {
    const aliases = resolveStaticAliases(opts.staticAlias);
    set("staticAliases", aliases, `static-alias=${aliases.map((a) => `${a.prefix}=${a.dir}`).join(",")}`);
  }
  set("uploadDir", opts.uploadDir as AppRecord["uploadDir"], `upload-dir=${opts.uploadDir}`);
  set("uploadPrefix", opts.uploadPrefix as AppRecord["uploadPrefix"], `upload-prefix=${opts.uploadPrefix}`);
  set("hotlinkProtect", opts.hotlinkProtect as AppRecord["hotlinkProtect"], `hotlink-protect=${opts.hotlinkProtect}`);
  set("hotlinkStrict", opts.hotlinkStrict as AppRecord["hotlinkStrict"], `hotlink-strict=${opts.hotlinkStrict}`);
  if ((opts.hotlinkAllow?.length ?? 0) > 0) set("hotlinkAllow", opts.hotlinkAllow, `hotlink-allow=${opts.hotlinkAllow!.join(",")}`);
  set("maxBodySize", opts.maxBody as AppRecord["maxBodySize"], `max-body=${opts.maxBody}`);
  set("scanBlock", opts.scanBlock as AppRecord["scanBlock"], `scan-block=${opts.scanBlock}`);

  if (changed.length === 0) {
    // --auto-static chạy lại trên app đã cấu hình đúng là chuyện BÌNH THƯỜNG
    // (nó nằm trong gợi ý của 'napp check'). Trả về "đã đúng rồi" chứ không
    // phải lỗi — nhưng vẫn kiểm tra quyền, vì cấu hình đúng mà nginx không đọc
    // được thì vẫn 403.
    if (opts.autoStatic) {
      ok(`${domain}: cấu hình asset tĩnh đã khớp với framework nhận diện được — không có gì để đổi.`);
      ensureNginxCanServe(app.user, appServePaths(app));
      return;
    }
    die(
      `Không có gì để đổi. Truyền ít nhất một tuỳ chọn, ví dụ:\n` +
        `  napp app set ${domain} --auto-static   (napp tự nhận diện framework từ thư mục build)\n` +
        `  napp app set ${domain} --static-root ${app.webRoot}/build/client --static-prefix /_app/`
    );
  }

  section(`Cập nhật cấu hình nginx cho ${domain}`);
  info(`Thay đổi: ${changed.join(" · ")}`);

  const conf = `${NGINX_AVAILABLE}/${domain}.conf`;
  if (!existsSync(conf)) die(`Không thấy vhost ${conf}. App này có được napp tạo không?`);

  // Sao lưu TRƯỚC mọi thay đổi, để `nginx -t` hỏng thì hoàn tác được về đúng
  // trạng thái cũ — kể cả file location (có thể đã tồn tại từ lần set trước).
  const confBak = `${conf}.napp-bak`;
  const locPath = appLocationsPath(domain);
  const locBak = `${locPath}.napp-bak`;
  runCmd("cp", ["-a", conf, confBak]);
  const locExisted = existsSync(locPath);
  if (locExisted) runCmd("cp", ["-a", locPath, locBak]);

  writeAppLocationsConf(app);

  let text = readFileSync(conf, "utf8");
  // client_max_body_size là chỉ thị ĐƠN đã có sẵn trong vhost — vá tại chỗ thay
  // vì thêm bản thứ hai, để không phụ thuộc vào thứ tự khai báo.
  if (opts.maxBody) {
    text = text.replace(/client_max_body_size\s+[^;]+;/, `client_max_body_size ${opts.maxBody};`);
  }
  const includeLine = `include ${locPath};`;
  const before = text;
  text = injectLocationsInclude(text, `proxy_pass http://napp_${slugFor(domain)}`, includeLine);
  writeFile(conf, text, 0o644);

  const rollback = () => {
    runCmd("cp", ["-a", confBak, conf], { silentFail: true });
    if (locExisted) runCmd("cp", ["-a", locBak, locPath], { silentFail: true });
    else runCmd("rm", ["-f", locPath], { silentFail: true });
  };

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    rollback();
    runCmd("rm", ["-f", confBak, locBak], { silentFail: true });
    die(`Cấu hình nginx sau khi sửa có lỗi — ĐÃ HOÀN TÁC toàn bộ:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  runCmd("rm", ["-f", confBak, locBak], { silentFail: true });

  app.updatedAt = new Date().toISOString();
  upsertApp(app);

  // Sau khi cấu hình đã đúng, quyền mới là thứ quyết định 200 hay 403.
  ensureNginxCanServe(app.user, appServePaths(app));

  ok(`Đã cập nhật và reload nginx.`);
  info(`• Location riêng: ${locPath}`);
  if (text !== before) info(`• Đã chèn '${includeLine}' vào vhost (một lần duy nhất; lần sau chỉ ghi lại file trên).`);
  if (app.staticRoot) info(`• Asset build giờ do NGINX trả, không qua Node.`);
  if ((app.staticAliases?.length ?? 0) > 0) {
    info(`• Tiền tố phục vụ bằng alias: ${app.staticAliases!.map((a) => `${a.prefix} → ${a.dir}`).join(" · ")}`);
  }
  if (app.uploadDir) info(`• File tải lên phục vụ từ ${app.uploadDir} (không phụ thuộc lần build gần nhất).`);
  if (opts.scanBlock === false) {
    warn(
      `• Chặn quét lỗ hổng ĐÃ TẮT cho ${domain}: request dò '/wp-login.php', '/phpmyadmin/'... lại đi qua Node ` +
        `và quay lại access log của site. Bật lại: napp app set ${domain} --scan-block`
    );
  } else if (opts.scanBlock === true) {
    info(`• Chặn quét lỗ hổng đã BẬT lại cho ${domain} (danh sách mẫu dùng chung: napp nginx scanblock để bật/tắt toàn máy).`);
  }
  if (app.hotlinkProtect) reportHotlink(app);
}

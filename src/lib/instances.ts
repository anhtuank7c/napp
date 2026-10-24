import { existsSync, readFileSync } from "node:fs";
import { execCapture, runCmd, writeFile } from "./exec";
import { info, ok, warn, step, die } from "./log";
import {
  SYSTEMD_DIR,
  NGINX_AVAILABLE,
  appUnits,
  serviceUnits,
  serviceNameFor,
  svcSystemdName,
  allocatePorts,
  releasePorts,
  upsertApp,
  upsertService,
  loadState,
  type AppRecord,
  type ServiceRecord,
} from "./state";
import { appUpstreamPath, appUpstreamName, renderAppUpstream } from "../templates/nginx";
import { renderPrimaryDropIn } from "../templates/systemd";
import { carryUserDirectives } from "./unitfile";

// --------------------------------------------------------------------------
// Chạy NHIỀU instance cho một app web / background service.
//
// Mô hình: unit template systemd 'napp-<slug>@.service' (như 'nexus@.service').
//   web app : tên instance = CỔNG   -> napp-shop@3001, napp-shop@3002 ...
//   worker  : tên instance = số thứ tự -> napp-svc-mail@1, @2 ...
//             (worker có --port: tên instance là cổng, như web)
// nginx chia request qua file upstream riêng (templates/nginx.ts).
//
// Opt-in: app chưa từng scale giữ nguyên unit 'napp-<slug>.service' như cũ.
// Lần scale đầu mới chuyển sang template — KHÔNG downtime: bật các instance
// mới trước, đưa vào nginx, rồi mới thay unit cũ bằng instance chính (cùng
// cổng cũ); trong khoảnh khắc thay, nginx đẩy request sang instance còn sống.
//
// Mọi thao tác đều chờ instance THỰC SỰ sống (đang nghe cổng / không crash)
// trước khi bước tiếp — systemctl báo "active" ngay khi tiến trình vừa được
// fork, lâu trước khi app nghe cổng; tin vào nó là deploy cuốn chiếu tắt hết
// instance cùng lúc.
// --------------------------------------------------------------------------

export const MAX_INSTANCES = 32;
const HEALTH_TIMEOUT_MS = 90_000; // app Next.js lớn có thể mất cả phút để nghe cổng
const WORKER_SETTLE_MS = 5_000; // worker không có cổng: sống qua 5s không crash là đạt

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// PID đang nghe một cổng TCP (ss -p cần root — mọi lệnh scale đều chạy bằng root).
// ss (iproute2) có sẵn trên mọi Ubuntu/Debian; -H bỏ dòng tiêu đề.
function listenerPids(port: number): number[] {
  const out = execCapture("ss", ["-Hltnp", `sport = :${port}`]).stdout;
  return [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
}

/** Cổng đang có tiến trình (bất kỳ) nghe — dùng khi cấp cổng mới cho instance. */
export function portBusy(port: number): boolean {
  return execCapture("ss", ["-Hltn", `sport = :${port}`]).stdout.trim() !== "";
}

// Tiến trình có thuộc unit này không — đọc cgroup của nó. Instance của template
// nằm ở '.../system-napp\x2dshop.slice/napp-shop@3001.service'.
function pidInUnit(pid: number, unit: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(`/${unit}`);
  } catch {
    return false;
  }
}

function unitProp(unit: string, prop: string): string {
  return execCapture("systemctl", ["show", "-p", prop, "--value", unit]).stdout.trim();
}

/**
 * Chờ một instance sống: có cổng thì chờ tới khi CHÍNH unit này nghe cổng;
 * không cổng thì chờ qua WORKER_SETTLE_MS mà unit vẫn active và không bị restart.
 * Trả về lý do thất bại, hoặc undefined nếu ổn.
 *
 * "Cổng đang được nghe" thôi là CHƯA ĐỦ: một tiến trình lạ chiếm sẵn cổng thì
 * instance thật crash liên tục vì EADDRINUSE, còn kiểm tra ngây thơ lại báo
 * "sống" — và nginx gửi request của người dùng cho tiến trình lạ kia (đã gặp
 * khi kiểm thử). Phải đúng là PID trong cgroup của unit đang nghe.
 */
export function waitHealthy(unit: string, port?: number, timeoutMs = HEALTH_TIMEOUT_MS): string | undefined {
  const deadline = Date.now() + timeoutMs;
  const restarts0 = unitProp(unit, "NRestarts");
  if (port === undefined) {
    sleepSync(WORKER_SETTLE_MS);
    const state = unitProp(unit, "ActiveState");
    if (state !== "active") return `${unit} không chạy (${state})`;
    if (unitProp(unit, "NRestarts") !== restarts0) return `${unit} crash và bị systemd khởi động lại`;
    return undefined;
  }
  while (Date.now() < deadline) {
    const state = unitProp(unit, "ActiveState");
    if (state === "failed") return `${unit} lỗi khi khởi động (xem: napp app logs / journalctl -u ${unit})`;
    const pids = listenerPids(port);
    if (state === "active" && pids.some((p) => pidInUnit(p, unit))) return undefined;
    if (unitProp(unit, "NRestarts") !== restarts0) {
      const foreign = pids.filter((p) => !pidInUnit(p, unit));
      return foreign.length > 0
        ? `${unit} không nghe được cổng ${port}: cổng đang bị tiến trình KHÁC chiếm (pid ${foreign.join(", ")})`
        : `${unit} crash ngay sau khi khởi động (xem: journalctl -u ${unit} -n 30)`;
    }
    sleepSync(500);
  }
  return `${unit} sau ${Math.round(timeoutMs / 1000)}s vẫn chưa nghe cổng ${port}`;
}

// Cấp cổng cho instance mới: trống trong sổ của napp VÀ không có ai đang nghe
// trên máy (Docker, dev server, dịch vụ cài tay... không có trong sổ của napp).
function freshPorts(count: number): string[] {
  return allocatePorts(count, portBusy).map(String);
}

export interface InstanceRef {
  unit: string;
  port?: number;
}

export function appInstanceRefs(app: AppRecord): InstanceRef[] {
  const units = appUnits(app);
  const ports = app.instances ? app.instances.map(Number) : [app.port];
  return units.map((unit, i) => ({ unit, port: ports[i] }));
}

export function serviceInstanceRefs(svc: ServiceRecord): InstanceRef[] {
  const units = serviceUnits(svc);
  if (svc.port === undefined) return units.map((unit) => ({ unit }));
  const ports = svc.instances ? svc.instances.map(Number) : [svc.port];
  return units.map((unit, i) => ({ unit, port: ports[i] }));
}

/**
 * Restart CUỐN CHIẾU: từng instance một, chờ sống rồi mới tới instance kế.
 * Có >= 2 instance thì luôn còn instance phục vụ — deploy không rớt request.
 * Một instance không lên được thì DỪNG NGAY (các instance chưa restart vẫn
 * chạy mã cũ và vẫn phục vụ) thay vì kéo đổ cả nhóm.
 */
export function rollingRestart(refs: InstanceRef[], label: string): void {
  if (refs.length === 1) {
    runCmd("systemctl", ["restart", refs[0]!.unit]);
    return;
  }
  info(`Khởi động lại cuốn chiếu ${refs.length} instance của ${label} (từng cái, chờ sống rồi mới tới cái kế)...`);
  for (const [i, r] of refs.entries()) {
    runCmd("systemctl", ["restart", r.unit]);
    const err = waitHealthy(r.unit, r.port);
    if (err) {
      die(
        `${err}\n` +
          `  DỪNG cuốn chiếu ở instance ${i + 1}/${refs.length}. ${refs.length - i - 1} instance chưa restart vẫn chạy bản cũ và vẫn phục vụ.\n` +
          `  Sửa lỗi rồi chạy lại, hoặc xem log: napp app logs / journalctl -u ${r.unit} -n 50`
      );
    }
    step(`${r.unit} ✓${r.port ? ` (đang nghe ${r.port})` : ""}`);
  }
}

/** Mọi instance của mọi app/service napp quản lý. */
export function allInstanceRefs(): InstanceRef[] {
  const s = loadState();
  return [...Object.values(s.apps).flatMap(appInstanceRefs), ...Object.values(s.services).flatMap(serviceInstanceRefs)];
}

export function systemctlAll(action: "start" | "stop" | "enable" | "disable", refs: InstanceRef[], silentFail = false): void {
  for (const r of refs) runCmd("systemctl", [action, r.unit], { silentFail });
}

export function anyActive(refs: InstanceRef[]): { active: number; total: number } {
  const active = refs.filter((r) => execCapture("systemctl", ["is-active", "--quiet", r.unit]).code === 0).length;
  return { active, total: refs.length };
}

// --- drop-in instance chính ----------------------------------------------------
function dropInDir(base: string, instance: string): string {
  return `${SYSTEMD_DIR}/${base}@${instance}.service.d`;
}

function writePrimaryDropIn(base: string, instance: string): void {
  writeFile(`${dropInDir(base, instance)}/napp-primary.conf`, renderPrimaryDropIn(), 0o644);
}

/** Gỡ mọi dấu vết template của một nhóm (file template + drop-in của từng instance). */
export function removeTemplateFiles(base: string, instances: string[]): void {
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${base}@.service`], { silentFail: true });
  for (const i of instances) runCmd("rm", ["-rf", dropInDir(base, i)], { silentFail: true });
}

/**
 * Mang phần SỬA TAY của unit cũ sang template trước khi napp ghi template.
 *
 * Cơ chế giữ directive sửa tay (lib/unitfile.ts) so file CŨ ở CÙNG đường dẫn
 * với bản render mới. Template 'napp-x@.service' là đường dẫn mới — ghi thẳng
 * thì mọi thứ người dùng đã sửa trong 'napp-x.service' (ExecStart, LimitNOFILE,
 * MemoryMax, log sang journal...) biến mất ngay lần scale đầu. Xem
 * carryUserDirectives() về cách nhận ra đúng phần người dùng sửa.
 */
function seedTemplateFromLegacy<T>(base: string, hooks: ScaleHooks<T>, legacyRec: T, next: T): void {
  const legacy = `${SYSTEMD_DIR}/${base}.service`;
  if (!existsSync(legacy)) return;
  const carried = carryUserDirectives(`${SYSTEMD_DIR}/${base}@.service`, hooks.render(next), readFileSync(legacy, "utf8"), hooks.render(legacyRec));
  if (carried.length > 0) info(`Mang sang template phần bạn đã sửa tay trong ${base}.service: ${carried.join(", ")}`);
}

/**
 * Sau khi ghi template: ExecStart phải còn phần gán biến theo instance. Thiếu
 * khi người dùng đã sửa tay ExecStart (được giữ nguyên ở bước trên) — khi đó
 * mọi instance cùng nghe cổng gốc và chết vì EADDRINUSE, nên dừng TRƯỚC khi
 * bật instance nào, kèm cách sửa.
 */
function assertInstanceExec(base: string, needPort: boolean): void {
  const path = `${SYSTEMD_DIR}/${base}@.service`;
  const exec = readFileSync(path, "utf8").match(/^ExecStart=(.*)$/m)?.[1] ?? "";
  const want = needPort ? "PORT=%i" : "NAPP_INSTANCE=%i";
  if (!exec.includes(want)) {
    die(
      `ExecStart trong unit của bạn đã được SỬA TAY và napp giữ nguyên nó, nhưng nó thiếu phần gán biến theo instance:\n` +
        `    ExecStart=${exec}\n` +
        `  Chạy nhiều instance cần mỗi instance nhận ${needPort ? "cổng" : "số thứ tự"} riêng. Sửa ExecStart trong /etc/systemd/system/${base}.service thành:\n` +
        `    ExecStart=/usr/bin/env ${needPort ? "PORT=%i " : ""}NAPP_INSTANCE=%i ${exec}\n` +
        `  (PHẢI qua /usr/bin/env — Environment= bị .env ghi đè), rồi chạy lại lệnh scale.`
    );
  }
}

// --- nginx ---------------------------------------------------------------------
// Khối upstream nội tuyến mà vhost của app CHƯA scale chứa (render bởi bản
// napp nào cũng cùng dạng). Lần scale đầu thay đúng khối này bằng một dòng include.
function inlineUpstreamRe(domain: string): RegExp {
  const name = appUpstreamName(domain).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`upstream\\s+${name}\\s*\\{[^}]*\\}\\n?`);
}

interface NginxBackup {
  restore(): void;
}

/**
 * Ghi file upstream + (lần đầu) thay khối upstream nội tuyến trong vhost bằng
 * include; 'nginx -t' hỏng thì khôi phục NGUYÊN TRẠNG cả hai file rồi die.
 */
export function applyUpstream(app: AppRecord): NginxBackup {
  const upPath = appUpstreamPath(app.domain);
  const vhostPath = `${NGINX_AVAILABLE}/${app.domain}.conf`;
  const upBefore = existsSync(upPath) ? readFileSync(upPath, "utf8") : undefined;
  const vhostBefore = existsSync(vhostPath) ? readFileSync(vhostPath, "utf8") : undefined;
  const restore = () => {
    if (upBefore === undefined) runCmd("rm", ["-f", upPath], { silentFail: true });
    else writeFile(upPath, upBefore, 0o644);
    if (vhostBefore !== undefined) writeFile(vhostPath, vhostBefore, 0o644);
  };

  writeFile(upPath, renderAppUpstream(app), 0o644);
  if (vhostBefore !== undefined && !vhostBefore.includes(`include ${upPath};`)) {
    const re = inlineUpstreamRe(app.domain);
    if (!re.test(vhostBefore)) {
      restore();
      die(
        `Không tìm thấy khối 'upstream ${appUpstreamName(app.domain)} { ... }' trong ${vhostPath} để thay bằng include.\n` +
          `  vhost đã bị sửa tay khác dạng napp sinh ra. Thêm thủ công dòng 'include ${upPath};' (ngoài khối server),\n` +
          `  xoá khối upstream cũ, rồi chạy lại lệnh scale.`
      );
    }
    writeFile(vhostPath, vhostBefore.replace(re, `include ${upPath};\n`), 0o644);
  }
  const t = execCapture("nginx", ["-t"]);
  if (t.code !== 0) {
    restore();
    die(`Cấu hình nginx sau khi đổi upstream có lỗi — ĐÃ KHÔI PHỤC nguyên trạng:\n${t.stderr.trim()}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  return {
    restore: () => {
      restore();
      if (execCapture("nginx", ["-t"]).code === 0) runCmd("systemctl", ["reload", "nginx"], { silentFail: true });
    },
  };
}

// --- scale -----------------------------------------------------------------------
export interface ScaleHooks<T> {
  // Ghi file unit (template hoặc thường) cho bản ghi đã cập nhật instances.
  writeUnit: (rec: T) => void;
  // Nội dung unit napp render cho bản ghi (chưa đóng dấu fingerprint) — để
  // phân biệt phần người dùng sửa tay với phần napp tự đổi khi chuyển template.
  render: (rec: T) => string;
}

function checkCount(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INSTANCES) die(`Số instance phải là số nguyên từ 1 tới ${MAX_INSTANCES} (nhận được: ${n}).`);
}

/**
 * Đổi số instance của một app web. Gọi bên trong khoá của app.
 * `writeUnit` dựng file unit từ bản ghi (đi kèm heap đã cân đối cho số instance mới).
 */
export function scaleApp(app: AppRecord, n: number, sticky: boolean | undefined, hooks: ScaleHooks<AppRecord>): AppRecord {
  checkCount(n);
  const base = serviceNameFor(app.domain);
  const cur = app.instances ?? [String(app.port)];
  const wantSticky = sticky ?? app.sticky;

  if (!app.instances && n === 1) {
    if (sticky !== undefined && sticky !== app.sticky) {
      const next = { ...app, sticky };
      upsertApp(next);
      info("Đã lưu lựa chọn sticky — có hiệu lực khi app chạy từ 2 instance.");
      return next;
    }
    ok(`${app.domain} đang chạy 1 instance (${base}.service) — không có gì thay đổi.`);
    return app;
  }

  // ---------- lần đầu: một unit -> template ----------
  if (!app.instances) {
    const newPorts = freshPorts(n - 1);
    const next: AppRecord = { ...app, instances: [String(app.port), ...newPorts], sticky: wantSticky };
    const added = newPorts.map((p) => ({ unit: `${base}@${p}.service`, port: Number(p) }));
    info(`Chuyển ${app.domain} sang chạy nhiều instance: ${base}.service -> ${base}@.service (instance = cổng).`);

    // Hoàn tác theo đúng bước đã đi tới — mọi lỗi (instance không lên, nginx
    // -t hỏng, chính systemctl lỗi) đều đưa máy về NGUYÊN TRẠNG trước khi scale.
    let nginx: NginxBackup | undefined;
    let swapped = false;
    const primary = { unit: `${base}@${app.port}.service`, port: app.port };
    const rollback = () => {
      if (swapped) {
        runCmd("systemctl", ["disable", "--now", primary.unit], { silentFail: true });
        runCmd("systemctl", ["enable", "--now", `${base}.service`], { silentFail: true });
      }
      nginx?.restore();
      systemctlAll("disable", added, true);
      systemctlAll("stop", added, true);
      removeTemplateFiles(base, next.instances!);
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
    };

    try {
      seedTemplateFromLegacy(base, hooks, app, next);
      hooks.writeUnit(next);
      assertInstanceExec(base, true);
      writePrimaryDropIn(base, String(app.port));
      runCmd("systemctl", ["daemon-reload"]);

      // 1. Instance MỚI lên trước, trên cổng mới — unit cũ vẫn phục vụ nguyên vẹn.
      for (const r of added) {
        runCmd("systemctl", ["enable", "--now", r.unit]);
        const err = waitHealthy(r.unit, r.port);
        if (err) die(err);
        step(`${r.unit} ✓ (đang nghe ${r.port})`);
      }

      // 2. nginx chia cho mọi cổng (cổng cũ vẫn do unit cũ giữ ở thời điểm này).
      nginx = applyUpstream(next);
      ok(`nginx đã chia request cho ${next.instances!.length} instance (${next.sticky ? "ip_hash — sticky" : "least_conn"}).`);

      // 3. Thay unit cũ bằng instance chính, CÙNG cổng. Khoảng trống vài giây ở
      //    cổng này được nginx bù bằng các instance mới.
      swapped = true;
      runCmd("systemctl", ["disable", "--now", `${base}.service`]);
      runCmd("systemctl", ["enable", "--now", primary.unit]);
      const err = waitHealthy(primary.unit, primary.port);
      if (err) die(err);
      step(`${primary.unit} ✓ thay cho ${base}.service (cổng ${app.port})`);
    } catch (e) {
      rollback();
      die(`${(e as Error).message}\n  ĐÃ HOÀN TÁC: ${base}.service chạy như cũ, nginx giữ một instance. Không có gì thay đổi.`);
    }

    runCmd("rm", ["-f", `${SYSTEMD_DIR}/${base}.service`]);
    runCmd("systemctl", ["daemon-reload"]);
    upsertApp(next);
    return next;
  }

  // ---------- đã là template: thêm / bớt ----------
  const next: AppRecord = { ...app, sticky: wantSticky };
  if (n > cur.length) {
    const newPorts = freshPorts(n - cur.length);
    next.instances = [...cur, ...newPorts];
    try {
      hooks.writeUnit(next); // heap mỗi instance nhỏ đi khi số instance tăng
      runCmd("systemctl", ["daemon-reload"]);
      for (const p of newPorts) {
        const r = { unit: `${base}@${p}.service`, port: Number(p) };
        runCmd("systemctl", ["enable", "--now", r.unit]);
        const err = waitHealthy(r.unit, r.port);
        if (err) die(err);
        step(`${r.unit} ✓ (đang nghe ${r.port})`);
      }
      // Chỉ đưa vào nginx SAU KHI đã sống — không request nào rơi vào cổng chưa nghe.
      applyUpstream(next);
    } catch (e) {
      for (const q of newPorts) runCmd("systemctl", ["disable", "--now", `${base}@${q}.service`], { silentFail: true });
      hooks.writeUnit(app);
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      die(`${(e as Error).message}\n  ĐÃ HOÀN TÁC: gỡ các instance mới, nhóm giữ ${cur.length} instance như cũ.`);
    }
    upsertApp(next);
    ok(`Đã tăng ${app.domain} lên ${n} instance.`);
  } else if (n < cur.length) {
    // Instance chính (phần tử đầu) không bao giờ bị bớt — nó giữ cổng gốc của app.
    const keep = cur.slice(0, n);
    const drop = cur.slice(n);
    next.instances = keep;
    // Rút khỏi nginx TRƯỚC, rồi mới dừng: request đang chạy dở trên instance
    // sắp tắt vẫn được nginx chờ xong (reload là graceful), request mới không tới nữa.
    applyUpstream(next);
    for (const p of drop) {
      runCmd("systemctl", ["disable", "--now", `${base}@${p}.service`], { silentFail: true });
      runCmd("rm", ["-rf", dropInDir(base, p)], { silentFail: true });
      step(`${base}@${p}.service đã dừng`);
    }
    hooks.writeUnit(next); // heap mỗi instance lớn lên khi bớt instance
    runCmd("systemctl", ["daemon-reload"]);
    upsertApp(next);
    releasePorts(drop.map(Number));
    ok(`Đã giảm ${app.domain} xuống ${n} instance.`);
  } else {
    if (next.sticky !== app.sticky) {
      applyUpstream(next);
      upsertApp(next);
      ok(`Đã chuyển upstream sang ${next.sticky ? "ip_hash (sticky)" : "least_conn"}.`);
    } else {
      ok(`${app.domain} đã chạy đúng ${n} instance — không có gì thay đổi.`);
    }
  }
  return next;
}

/** Như scaleApp nhưng cho background service (không có nginx). */
export function scaleService(svc: ServiceRecord, n: number, hooks: ScaleHooks<ServiceRecord>): ServiceRecord {
  checkCount(n);
  const base = svcSystemdName(svc.name);
  const hasPort = svc.port !== undefined;
  const ref = (id: string) => ({ unit: `${base}@${id}.service`, port: hasPort ? Number(id) : undefined });

  if (!svc.instances && n === 1) {
    ok(`${svc.name} đang chạy 1 instance (${base}.service) — không có gì thay đổi.`);
    return svc;
  }

  if (!svc.instances) {
    const first = hasPort ? String(svc.port) : "1";
    const rest = hasPort ? freshPorts(n - 1) : Array.from({ length: n - 1 }, (_, i) => String(i + 2));
    const next: ServiceRecord = { ...svc, instances: [first, ...rest] };
    info(`Chuyển ${svc.name} sang chạy nhiều instance: ${base}.service -> ${base}@.service.`);
    const primary = ref(first);
    let swapped = false;
    try {
      seedTemplateFromLegacy(base, hooks, svc, next);
      hooks.writeUnit(next);
      assertInstanceExec(base, hasPort);
      writePrimaryDropIn(base, first);
      runCmd("systemctl", ["daemon-reload"]);
      for (const id of rest) {
        const r = ref(id);
        runCmd("systemctl", ["enable", "--now", r.unit]);
        const err = waitHealthy(r.unit, r.port);
        if (err) die(err);
        step(`${r.unit} ✓`);
      }
      swapped = true;
      runCmd("systemctl", ["disable", "--now", `${base}.service`]);
      runCmd("systemctl", ["enable", "--now", primary.unit]);
      const err = waitHealthy(primary.unit, primary.port);
      if (err) die(err);
      step(`${primary.unit} ✓ thay cho ${base}.service`);
    } catch (e) {
      if (swapped) {
        runCmd("systemctl", ["disable", "--now", primary.unit], { silentFail: true });
        runCmd("systemctl", ["enable", "--now", `${base}.service`], { silentFail: true });
      }
      for (const id of rest) runCmd("systemctl", ["disable", "--now", ref(id).unit], { silentFail: true });
      removeTemplateFiles(base, next.instances!);
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      die(`${(e as Error).message}\n  ĐÃ HOÀN TÁC: ${base}.service chạy như cũ.`);
    }
    runCmd("rm", ["-f", `${SYSTEMD_DIR}/${base}.service`]);
    runCmd("systemctl", ["daemon-reload"]);
    upsertService(next);
    return next;
  }

  const cur = svc.instances;
  const next: ServiceRecord = { ...svc };
  if (n > cur.length) {
    const add = hasPort
      ? freshPorts(n - cur.length)
      : Array.from({ length: n - cur.length }, (_, i) => String(Math.max(...cur.map(Number)) + i + 1));
    next.instances = [...cur, ...add];
    try {
      hooks.writeUnit(next);
      runCmd("systemctl", ["daemon-reload"]);
      for (const id of add) {
        const r = ref(id);
        runCmd("systemctl", ["enable", "--now", r.unit]);
        const err = waitHealthy(r.unit, r.port);
        if (err) die(err);
        step(`${r.unit} ✓`);
      }
    } catch (e) {
      for (const q of add) runCmd("systemctl", ["disable", "--now", ref(q).unit], { silentFail: true });
      hooks.writeUnit(svc);
      runCmd("systemctl", ["daemon-reload"], { silentFail: true });
      die(`${(e as Error).message}\n  ĐÃ HOÀN TÁC: nhóm giữ ${cur.length} instance như cũ.`);
    }
    upsertService(next);
    ok(`Đã tăng ${svc.name} lên ${n} instance.`);
  } else if (n < cur.length) {
    const drop = cur.slice(n);
    next.instances = cur.slice(0, n);
    // Worker nhận SIGTERM và có TimeoutStopSec=15s để làm nốt job đang dở —
    // worker hàng đợi (BullMQ...) đúng chuẩn sẽ trả job về hàng chứ không làm mất.
    for (const id of drop) {
      runCmd("systemctl", ["disable", "--now", ref(id).unit], { silentFail: true });
      runCmd("rm", ["-rf", dropInDir(base, id)], { silentFail: true });
      step(`${ref(id).unit} đã dừng`);
    }
    hooks.writeUnit(next);
    runCmd("systemctl", ["daemon-reload"]);
    upsertService(next);
    if (hasPort) releasePorts(drop.map(Number));
    ok(`Đã giảm ${svc.name} xuống ${n} instance.`);
  } else {
    ok(`${svc.name} đã chạy đúng ${n} instance — không có gì thay đổi.`);
  }
  return next;
}


import { execCapture, runCmd, requireRoot, ensureDir, writeFile, commandExists, isServiceActive } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { detectHardware, formatHardware, detectResourceControl, formatResourceControl } from "../lib/hardware";
import {
  computeTuningPlan,
  renderRedisTuning,
  renderSysctlTuning,
  serviceMemoryHighMB,
  CPU_WEIGHT_WEB,
  CPU_WEIGHT_SERVICE,
  IO_WEIGHT_WEB,
  IO_WEIGHT_SERVICE,
  REDIS_TUNING_PATH,
  SYSCTL_TUNING_PATH,
} from "../templates/tuning";
import { renderNginxTuningConf, NGINX_TUNING_CONF } from "../templates/nginx";
import { loadState, saveState, serviceNameFor, svcSystemdName } from "../lib/state";
import { applyNodeHeaps, syncAllUnits, reportBalance } from "./app";
import { activeEngines, driverFor, unmanagedEngines } from "../lib/db";
import type { HardwareProfile } from "../lib/hardware";
import type { TuningPlan } from "../templates/tuning";
import { readFileSync, existsSync } from "node:fs";

/** In phần phân bổ RAM cho database — dùng chung cho `tune show` và `tune apply`. */
function printDbPlan(hw: HardwareProfile, plan: TuningPlan): void {
  const engines = activeEngines();
  if (engines.length === 0) {
    console.log(`  Database           : không có engine nào — 0% RAM dành cho DB, phần đó về heap của app Node`);
  } else {
    console.log(
      `  Database           : ${plan.dbRamPercent}% RAM cho ${engines.length} engine` +
        (engines.length > 1 ? ` — chia đều, mỗi engine ${plan.dbBudgetPerEngineMB} MB` : ` (${plan.dbBudgetPerEngineMB} MB)`)
    );
    for (const e of engines) {
      const d = driverFor(e);
      for (const line of d.describeTuning?.(hw, plan.dbBudgetPerEngineMB) ?? []) console.log(`    ${d.label.padEnd(11)}: ${line}`);
    }
  }
  const unmanaged = unmanagedEngines();
  if (unmanaged.length > 0) {
    console.log(`    (đã cài nhưng napp KHÔNG quản lý, không tune: ${unmanaged.join(", ")} — xem 'napp db engine list')`);
  }
}

/** Ghi cấu hình tuning cho mọi engine napp đang quản lý. */
export function applyDbTuning(hw: HardwareProfile, plan: TuningPlan, opts: { skipRestart: boolean }): void {
  const engines = activeEngines();
  if (engines.length === 0) {
    info("Không có database engine nào được cài — bỏ qua tuning database.");
    return;
  }
  for (const e of engines) {
    const d = driverFor(e);
    if (!d.applyTuning) continue;
    try {
      d.applyTuning(hw, plan.dbBudgetPerEngineMB, opts);
    } catch (err) {
      // Một engine lỗi không được chặn các phần tuning còn lại.
      warn(`Tuning ${d.label} thất bại: ${(err as Error).message}`);
    }
  }
}

/** Phần in chung về ưu tiên tài nguyên — dùng cho cả `tune show` và `tune apply`. */
function printPriorityPlan(serviceHeapMB: number): void {
  const rc = detectResourceControl();
  section("Ưu tiên tài nguyên: web app > background service");
  console.log(`  CPUWeight            : web app ${CPU_WEIGHT_WEB} · service ${CPU_WEIGHT_SERVICE} (mặc định systemd là 100)`);
  console.log(
    `                         -> KHI TRANH CHẤP, web app được ~${(CPU_WEIGHT_WEB / CPU_WEIGHT_SERVICE).toFixed(0)}x phần CPU. ` +
      `Không tranh chấp thì không ai bị giới hạn.`
  );
  console.log(`  IOWeight             : web app ${IO_WEIGHT_WEB} · service ${IO_WEIGHT_SERVICE}`);
  console.log(
    rc.cgroupV2
      ? `  MemoryHigh (service) : ${serviceMemoryHighMB(serviceHeapMB)} MB — giới hạn MỀM (throttle + thu hồi, KHÔNG giết tiến trình)`
      : `  MemoryHigh (service) : bỏ qua (cần cgroup v2)`
  );
  console.log();
  console.log("  Thực tế trên máy này:");
  for (const line of formatResourceControl(rc)) console.log(line);
}

export function cmdTuneShow(): void {
  const hw = detectHardware();
  const st = loadState();
  const mix = { webApps: Object.keys(st.apps).length, services: Object.keys(st.services).length };
  section("Phần cứng phát hiện được");
  console.log(formatHardware(hw));
  const plan = computeTuningPlan(hw, undefined, mix, st.serviceHeapWeight, activeEngines().length);
  console.log();
  section("Kế hoạch tối ưu (chưa áp dụng — dùng `napp tune apply`)");
  printDbPlan(hw, plan);
  console.log(`  Redis maxmemory    : ${plan.redisMaxMemoryMB} MB (maxmemory-policy: noeviction — bắt buộc cho BullMQ)`);
  console.log(`  nginx worker_connections : ${plan.workerConnections}`);
  // Máy chưa có đơn vị nào: cả hai con số đều bị kẹp về trần của tier, in ra
  // như một "kế hoạch" là gây hiểu nhầm (trông như mỗi app sẽ được từng ấy RAM).
  console.log(
    mix.webApps + mix.services === 0
      ? `  Node heap            : chưa có app/service nào — heap được chia lại mỗi lần tạo hoặc xoá đơn vị`
      : `  Node heap            : web app ${plan.heap.webMB} MB · background service ${plan.heap.serviceMB} MB ` +
        `(${mix.webApps} app + ${mix.services} service, trọng số service ${plan.heap.serviceWeight}; chỉ runtime=node)`
  );
  console.log();
  printPriorityPlan(plan.heap.serviceMB);
}

export interface TuneApplyOptions {
  dbRamPercent?: number;
  yes: boolean;
  skipRestart: boolean;
  // Render lại TOÀN BỘ unit systemd từ template thay vì chỉ vá con số heap.
  // Mặc định TẮT: đường chạy này đổi nhiều dòng, và unit là nơi người dùng hay
  // sửa tay nhất (ExecStart, StandardOutput/Error, User, Group) — chạm vào nó
  // phải là một quyết định của người dùng, không phải tác dụng phụ của lệnh tune.
  syncUnits: boolean;
  // Trọng số heap của background service so với web app (0.1–1). Được LƯU vào
  // registry, nên mọi lần tạo/xoá app sau đó vẫn giữ đúng tỷ lệ này.
  serviceWeight?: number;
}

// Patch worker_processes/worker_connections trong khối `events {}` /
// `main` của nginx.conf — các tham số này KHÔNG thể đặt trong conf.d/*.conf
// (nginx chỉ cho phép ở ngữ cảnh gốc / events), nên cần sửa trực tiếp.
function patchNginxMainConf(workerConnections: number): void {
  const path = "/etc/nginx/nginx.conf";
  if (!existsSync(path)) {
    warn(`Không tìm thấy ${path} — bỏ qua patch worker_processes/worker_connections.`);
    return;
  }
  let content = readFileSync(path, "utf8");
  if (/^\s*worker_processes\s+/m.test(content)) {
    content = content.replace(/^\s*worker_processes\s+.*/m, "worker_processes auto; # managed by napp tune");
  } else {
    content = `worker_processes auto; # managed by napp tune\n${content}`;
  }
  if (/worker_connections\s+\d+/m.test(content)) {
    content = content.replace(/worker_connections\s+\d+;/m, `worker_connections ${workerConnections}; # managed by napp tune`);
  }
  writeFile(path, content, 0o644);
}

/**
 * Đối chiếu với GIÁ TRỊ THẬT TRONG KERNEL, không phải với thứ systemd nói.
 *
 * Ghi vào file unit rồi kết luận "xong" là chỗ dễ nói dối nhất của cả tính năng
 * này. Và `systemctl show -p CPUWeight` KHÔNG đủ để bác bỏ: nó chỉ đọc lại giá
 * trị đã CẤU HÌNH trong unit, kể cả khi cgroup controller 'cpu' không bật và
 * dòng đó hoàn toàn vô hiệu. Đo trên máy thật: 'systemctl show' trả 200 trong
 * khi hai tiến trình vẫn chia CPU 1:1.
 *
 * Nguồn sự thật duy nhất là file 'cpu.weight' trong cgroup của chính unit đó —
 * nó chỉ tồn tại khi kernel THỰC SỰ đang áp trọng số.
 *
 * Chỉ kiểm được đơn vị ĐANG CHẠY: unit đã dừng thì không có cgroup nào cả.
 */
function verifyEffectivePriority(st: ReturnType<typeof loadState>): void {
  const units = [
    ...Object.keys(st.apps).map((d) => ({ unit: `${serviceNameFor(d)}.service`, want: CPU_WEIGHT_WEB })),
    ...Object.keys(st.services).map((n) => ({ unit: `${svcSystemdName(n)}.service`, want: CPU_WEIGHT_SERVICE })),
  ];

  const mismatched: string[] = [];
  const inert: string[] = [];
  let verified = 0;

  for (const { unit, want } of units) {
    const cg = execCapture("systemctl", ["show", "-p", "ControlGroup", "--value", unit]);
    const path = cg.stdout.trim();
    if (cg.code !== 0 || !path) continue; // chưa chạy -> không có gì để đo
    const weightFile = `/sys/fs/cgroup${path}/cpu.weight`;
    if (!existsSync(weightFile)) {
      // Không có file = controller 'cpu' chưa bật cho nhánh cgroup này -> dòng
      // CPUWeight trong unit KHÔNG có tác dụng gì, dù systemctl vẫn in ra nó.
      inert.push(unit);
      continue;
    }
    const actual = readFileSync(weightFile, "utf8").trim();
    if (actual === String(want)) verified++;
    else mismatched.push(`${unit} (kernel đang áp ${actual}, mong đợi ${want})`);
  }

  if (verified > 0 && mismatched.length === 0 && inert.length === 0) {
    ok(`Đã đối chiếu với kernel: cpu.weight đúng trên cả ${verified} đơn vị đang chạy — ưu tiên CPU có hiệu lực THẬT.`);
    return;
  }
  if (inert.length > 0) {
    warn(
      `${inert.length} đơn vị KHÔNG có 'cpu.weight' trong cgroup (${inert.join(", ")}) — cgroup controller 'cpu' chưa bật cho nhánh này, ` +
        `nên dòng CPUWeight trong unit hiện KHÔNG có tác dụng (systemctl vẫn in ra giá trị đã cấu hình, đừng tin nó).\n` +
        `  Thường tự hết sau: sudo systemctl daemon-reload && sudo systemctl restart <unit>.\n` +
        `  Nếu vẫn không có: kernel/cgroup của máy này không cấp controller 'cpu' (hay gặp trên VPS nền OpenVZ/LXC).`
    );
  }
  if (mismatched.length > 0) {
    warn(`cpu.weight trong kernel chưa khớp với cấu hình:\n${mismatched.map((m) => `  - ${m}`).join("\n")}\n  Thử: sudo systemctl restart <unit>.`);
  }
}

export async function cmdTuneApply(opts: TuneApplyOptions): Promise<void> {
  requireRoot();
  const hw = detectHardware();
  const st = loadState();
  const mix = { webApps: Object.keys(st.apps).length, services: Object.keys(st.services).length };

  // Trọng số mới được LƯU trước khi tính, để applyNodeHeaps (đọc registry) và
  // mọi lần tạo/xoá app về sau đều dùng đúng con số này. Chỉ là cờ của một lần
  // chạy thì lần `app create` kế tiếp sẽ tính lại theo mặc định và lật ngược
  // lựa chọn của người dùng mà không ai thấy.
  if (opts.serviceWeight !== undefined) {
    if (!(opts.serviceWeight >= 0.1 && opts.serviceWeight <= 1)) {
      die(`--service-weight phải nằm trong khoảng 0.1–1 (nhận được: ${opts.serviceWeight}). 1 = chia đều như trước, 0.5 = web app gấp đôi service.`);
    }
    st.serviceHeapWeight = opts.serviceWeight;
    saveState(st);
  }
  const plan = computeTuningPlan(hw, opts.dbRamPercent, mix, st.serviceHeapWeight, activeEngines().length);

  section("Tối ưu theo phần cứng thực tế");
  console.log(formatHardware(hw));
  console.log();
  printDbPlan(hw, plan);
  console.log(`  Redis maxmemory    -> ${plan.redisMaxMemoryMB} MB (maxmemory-policy: noeviction — bắt buộc cho BullMQ)`);
  console.log(`  nginx worker_connections -> ${plan.workerConnections}`);
  console.log(
    `  Node heap          -> web app ${plan.heap.webMB} MB · background service ${plan.heap.serviceMB} MB ` +
      `(${mix.webApps} app + ${mix.services} service, trọng số service ${plan.heap.serviceWeight})`
  );
  console.log();
  printPriorityPlan(plan.heap.serviceMB);
  if (hw.diskFreeGB > 0 && hw.diskFreeGB < 5) {
    warn(`Ổ đĩa trống chỉ còn ${hw.diskFreeGB} GB — chú ý dung lượng cho log/AOF Redis/backup.`);
  }
  console.log();

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("Áp dụng cấu hình trên và khởi động lại nginx/database/Redis + các app? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ. Không thay đổi gì.");
      return;
    }
  }

  // sysctl — luôn an toàn để áp, không phụ thuộc service nào đang chạy.
  writeFile(SYSCTL_TUNING_PATH, renderSysctlTuning(), 0o644);
  const sysctlRes = runCmd("sysctl", ["--system"], { silentFail: true });
  if (sysctlRes.code !== 0) {
    warn(
      "Một số tham số sysctl không áp được trên kernel/hạ tầng hiện tại (thường do thiếu module, ví dụ sch_fq " +
        "cho net.core.default_qdisc trên vài container/kernel tối giản) — các tham số còn lại vẫn đã được áp."
    );
  } else {
    ok("Đã áp sysctl tuning.");
  }

  // nginx
  if (commandExists("nginx")) {
    ensureDir("/etc/nginx/conf.d", 0o755);
    writeFile(NGINX_TUNING_CONF, renderNginxTuningConf(hw.cpuCores, hw.tier), 0o644);
    patchNginxMainConf(plan.workerConnections);
    const test = execCapture("nginx", ["-t"]);
    if (test.code !== 0) {
      warn(`Cấu hình nginx sau khi tune có lỗi cú pháp — ĐÃ GHI FILE nhưng KHÔNG reload:\n${test.stderr}`);
    } else if (!opts.skipRestart) {
      runCmd("systemctl", ["reload", "nginx"]);
      ok("Đã áp tuning cho nginx và reload.");
    }
  } else {
    warn("nginx chưa cài — bỏ qua.");
  }

  // Database — mọi engine napp đang quản lý, mỗi engine một phần ngân sách.
  applyDbTuning(hw, plan, { skipRestart: opts.skipRestart });

  // Redis
  if (commandExists("redis-server")) {
    ensureDir("/etc/redis/conf.d", 0o755);
    writeFile(REDIS_TUNING_PATH, renderRedisTuning(hw, plan), 0o644);
    // Ubuntu package redis-server thường không tự include conf.d/*.conf —
    // đảm bảo có dòng include trong redis.conf chính.
    const mainConf = "/etc/redis/redis.conf";
    if (existsSync(mainConf)) {
      const content = readFileSync(mainConf, "utf8");
      if (!content.includes("conf.d/*.conf")) {
        writeFile(mainConf, content + "\ninclude /etc/redis/conf.d/*.conf\n", 0o640);
      }
    }
    if (!opts.skipRestart && isServiceActive("redis-server")) {
      runCmd("systemctl", ["restart", "redis-server"]);
      ok("Đã áp tuning cho Redis và khởi động lại.");
    } else {
      ok(`Đã ghi ${REDIS_TUNING_PATH} — service chưa chạy nên chưa restart.`);
    }
  } else {
    warn("Redis chưa cài — bỏ qua.");
  }

  // Các app: cân đối lại heap V8 (chia theo tổng số đơn vị node). Mặc định CHỈ
  // vá đúng con số trong --max-old-space-size, không đụng dòng nào khác của unit
  // — xem applyNodeHeaps. Muốn đẩy cả phần template mới xuống unit cũ thì dùng
  // --sync-units. Chỉ restart khi không --skip-restart.
  const unitCount = mix.webApps + mix.services;
  if (unitCount > 0) {
    if (opts.syncUnits) {
      const heap = syncAllUnits({ restart: !opts.skipRestart });
      ok(
        `Đã render lại unit systemd cho ${unitCount} đơn vị (heap: web ${heap.webMB} MB · service ${heap.serviceMB} MB)` +
          (opts.skipRestart ? " — chưa restart do --skip-restart." : " và khởi động lại.")
      );
    } else {
      const res = applyNodeHeaps({ restart: !opts.skipRestart });
      ok(
        `Đã cân đối heap V8 + ưu tiên tài nguyên cho ${unitCount} đơn vị (chỉ sửa dòng --max-old-space-size, ` +
          `CPUWeight, IOWeight, MemoryHigh — phần còn lại của unit giữ nguyên)` +
          (opts.skipRestart ? " — chưa restart do --skip-restart." : ".")
      );
      reportBalance(res);
      if (opts.skipRestart && res.heapChanged.length > 0) {
        info(`Heap mới chỉ áp sau khi restart: ${res.heapChanged.join(", ")} (NODE_OPTIONS chỉ được đọc lúc tiến trình khởi động).`);
      }
      info("Muốn đồng bộ luôn phần hardening/template mới xuống unit cũ: napp tune apply --sync-units");
    }
    verifyEffectivePriority(st);
  }

  console.log();
  ok("Hoàn tất. Chạy lại lệnh này bất cứ khi nào nâng cấp phần cứng server.");
}

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { ask } from "../lib/prompt";
import { execCapture, runCmd, requireRoot, writeFile, ensureDir, commandExists } from "../lib/exec";
import { info, ok, warn, die, section, colorText } from "../lib/log";
import { writeManagedUnit } from "../lib/unitfile";
import { showTimer } from "../lib/timer";
import { loadState, upsertApp, upsertService, SYSTEMD_DIR } from "../lib/state";
import { writeAppUnit, writeServiceUnit, currentHeapPlan } from "./app";
import { renderMemwatchService, renderMemwatchTimer, unitWorkDir } from "../templates/systemd";
import {
  allUnits, readUnitMemory, readSamples, takeSample, analyseTrend, strayHeapSnapshots,
  MEMWATCH_LOG, MEMWATCH_TIMER_NAME, HEAPSNAP_DIR,
  type UnitRef, type Trend, type Verdict,
} from "../lib/memwatch";

const NAPP_BIN_PATH = "/usr/local/bin/napp";

const mb = (b?: number) => (b === undefined ? "—" : `${Math.round(b / 1048576)} MB`);

/** Ngủ ĐỒNG BỘ — cả file này viết theo lối tuần tự như phần còn lại của napp. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function verdictLabel(v: Verdict): string {
  if (v === "leak") return colorText("red", "RÒ RỈ");
  if (v === "watch") return colorText("yellow", "THEO DÕI");
  if (v === "ok") return colorText("green", "ổn định");
  return colorText("dim", "chưa đủ dữ liệu");
}

export function cmdMemStatus(): void {
  const units = allUnits();
  if (units.length === 0) {
    info("Chưa có app/service nào để theo dõi.");
    return;
  }
  const samples = readSamples();

  section("Bộ nhớ từng đơn vị node");
  for (const ref of units) {
    const m = readUnitMemory(ref);
    const t = analyseTrend(samples, m.unit);
    const head = `${m.unit}${m.kind === "service" ? " (service)" : ""}`;
    console.log(`\n  ${colorText("blue", head)}${m.active ? "" : colorText("red", "  [ĐANG DỪNG]")}`);
    console.log(`    Bộ nhớ ẩn danh (heap/stack) : ${mb(m.anonBytes)}${m.peakBytes ? `   · đỉnh: ${mb(m.peakBytes)}` : ""}`);
    if (m.memoryHighBytes !== undefined) {
      const throttled = (m.highEvents ?? 0) > 0;
      console.log(
        `    MemoryHigh (giới hạn mềm)   : ${mb(m.memoryHighBytes)} · số lần bị throttle: ` +
          (throttled ? colorText("yellow", String(m.highEvents)) : "0")
      );
    }
    // ĐÂY mới là tín hiệu quan trọng nhất, và là thứ đã bị bỏ lỡ: 'Restart=always'
    // khiến app rò rỉ chết rồi tự sống lại trong im lặng, ngày này qua ngày khác.
    const r = m.restarts;
    console.log(`    systemd đã khởi động lại    : ${r > 0 ? colorText("yellow", String(r)) : "0"} lần${m.lastResult ? ` · lần dừng gần nhất: ${colorText("red", m.lastResult)}` : ""}`);
    if (t.verdict === "insufficient") {
      console.log(`    Xu hướng                    : ${verdictLabel(t.verdict)}${t.samples > 0 ? ` (${t.samples} mẫu, ${t.spanHours}h — cần ít nhất 8 mẫu trải 6h)` : " (chưa lấy mẫu lần nào)"}`);
    } else {
      console.log(
        `    Xu hướng (${t.spanHours}h, ${t.samples} mẫu)    : ${verdictLabel(t.verdict)} — ` +
          `${t.baselineMB} MB → ${t.currentMB} MB (${t.growthMB >= 0 ? "+" : ""}${t.growthMB} MB, ${t.growthPct >= 0 ? "+" : ""}${t.growthPct}%, ~${t.mbPerDay} MB/ngày)`
      );
    }
  }

  reportFindings(units, samples);
}

/** Phần kết luận + gợi ý hành động, dùng chung cho 'mem show' và 'mem show --trend'. */
function reportFindings(units: UnitRef[], samples: ReturnType<typeof readSamples>): void {
  console.log();
  const leaks: Trend[] = [];
  const restarted: string[] = [];
  for (const ref of units) {
    const t = analyseTrend(samples, ref.unit);
    if (t.verdict === "leak" || t.verdict === "watch") leaks.push(t);
    const m = readUnitMemory(ref);
    if (m.restarts > 0) restarted.push(`${m.unit} (${m.restarts} lần${m.lastResult ? `, gần nhất: ${m.lastResult}` : ""})`);
  }

  if (restarted.length > 0) {
    warn(
      `systemd đã âm thầm khởi động lại: ${restarted.join(", ")}.\n` +
        `  Unit napp đều có 'Restart=always', nên app chạm trần heap sẽ CHẾT rồi tự sống lại mà không ai hay.\n` +
        `  Xem nguyên nhân: journalctl -u <unit> --since '7 days ago' | grep -iE 'out of memory|oom|heap'`
    );
  }
  for (const t of leaks) {
    const line =
      `${t.unit}: bộ nhớ tăng ${t.growthMB} MB (+${t.growthPct}%) trong ${t.spanHours}h kể từ lần khởi động gần nhất, ~${t.mbPerDay} MB/ngày.`;
    if (t.verdict === "leak") warn(`${line}\n  Chụp heap để tìm thủ phạm: sudo napp mem snapshot <domain|name>`);
    else info(`${line} (chưa kết luận — theo dõi thêm)`);
  }

  const stray = strayHeapSnapshots();
  if (stray.length > 0) {
    warn(
      `Tìm thấy file .heapsnapshot còn sót trong thư mục app — đây là BẰNG CHỨNG app đã chạm trần heap:\n` +
        stray.map((s) => `  - ${s.id}: ${s.files.map((f) => `${f.name} (${f.mb} MB)`).join(", ")}\n    tại ${s.dir}`).join("\n") +
        `\n  Tải về máy rồi mở bằng Chrome DevTools > Memory > Load. Nhớ XOÁ đi sau: file này rất to.\n` +
        `  File 0 MB hoặc nhỏ bất thường so với heap là bản CỤT — Node bị dừng giữa chừng lúc đang ghi\n` +
        `  (ghi xong một snapshot có thể mất vài phút). Bản cụt vẫn là file .heapsnapshot nhưng không mở được.`
    );
  }

  if (restarted.length === 0 && leaks.length === 0 && stray.length === 0) {
    ok("Không thấy dấu hiệu rò rỉ bộ nhớ.");
  }
  if (samples.length === 0) {
    info(`Chưa có dữ liệu xu hướng. Bật lấy mẫu định kỳ: sudo napp mem watch enable`);
  }
}

export function cmdMemTrend(): void {
  const samples = readSamples();
  if (samples.length === 0) {
    info(`Chưa có mẫu nào ở ${MEMWATCH_LOG}. Bật lấy mẫu định kỳ: sudo napp mem watch enable`);
    return;
  }
  section(`Xu hướng bộ nhớ (${samples.length} mẫu)`);
  for (const ref of allUnits()) {
    const t = analyseTrend(samples, ref.unit);
    if (t.verdict === "insufficient") {
      console.log(`  ${ref.unit.padEnd(34)} ${verdictLabel(t.verdict)} (${t.samples} mẫu, ${t.spanHours}h)`);
      continue;
    }
    console.log(
      `  ${ref.unit.padEnd(34)} ${verdictLabel(t.verdict)}  ${t.baselineMB} → ${t.currentMB} MB ` +
        `(${t.growthMB >= 0 ? "+" : ""}${t.growthMB} MB / ${t.spanHours}h, ~${t.mbPerDay} MB/ngày)` +
        (t.restartsSeen > 0 ? colorText("dim", `  [đã restart ${t.restartsSeen} lần trong log — chỉ tính từ lần gần nhất]`) : "")
    );
  }
  reportFindings(allUnits(), samples);
}

export function cmdMemSample(opts: { quiet?: boolean } = {}): void {
  requireRoot();
  const n = takeSample();
  if (!opts.quiet) {
    if (n === 0) info("Không có đơn vị nào đang chạy để lấy mẫu.");
    else ok(`Đã ghi ${n} mẫu vào ${MEMWATCH_LOG}.`);
  }
}

/** '*:0/15' khi 15 chia hết 60; ngoài ra lùi về OnUnitActiveSec. */
function intervalToOnCalendar(minutes: number): string {
  if (minutes < 1 || minutes > 1440) die(`--interval phải trong khoảng 1–1440 phút (nhận được: ${minutes}).`);
  if (minutes < 60 && 60 % minutes === 0) return `*:0/${minutes}`;
  if (minutes === 60) return "hourly";
  if (minutes % 60 === 0) return `*-*-* 0/${minutes / 60}:00:00`;
  die(`--interval ${minutes} không chia đều được vào giờ. Hãy chọn 1, 5, 10, 15, 20, 30, 60, hoặc bội số của 60.`);
}

export function cmdMemWatch(opts: { interval: number }): void {
  requireRoot();
  const onCalendar = intervalToOnCalendar(opts.interval);
  writeManagedUnit(`${SYSTEMD_DIR}/${MEMWATCH_TIMER_NAME}.service`, renderMemwatchService(NAPP_BIN_PATH), { authoritative: ["ExecStart"] });
  writeFile(`${SYSTEMD_DIR}/${MEMWATCH_TIMER_NAME}.timer`, renderMemwatchTimer(onCalendar), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", `${MEMWATCH_TIMER_NAME}.timer`]);
  // Lấy ngay một mẫu để log không rỗng cho tới nhịp hẹn giờ đầu tiên.
  takeSample();
  ok(`Đã bật lấy mẫu bộ nhớ mỗi ${opts.interval} phút (${onCalendar}).`);
  info(`• Dữ liệu: ${MEMWATCH_LOG} (tự giữ 20000 mẫu gần nhất, không cần logrotate)`);
  info(`• Xem kết quả: napp mem show --trend — cần ÍT NHẤT 6 giờ dữ liệu mới kết luận được gì`);
  info(`• Lịch chạy: systemctl list-timers ${MEMWATCH_TIMER_NAME}.timer`);
}

export function cmdMemUnwatch(): void {
  requireRoot();
  runCmd("systemctl", ["disable", "--now", `${MEMWATCH_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${MEMWATCH_TIMER_NAME}.service`, `${SYSTEMD_DIR}/${MEMWATCH_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"]);
  ok("Đã tắt lấy mẫu bộ nhớ.");
  info(`Dữ liệu cũ vẫn giữ ở ${MEMWATCH_LOG} (xoá tay nếu không cần).`);
}

/**
 * NODE_OPTIONS THẬT SỰ của tiến trình đang chạy, đọc từ /proc/<pid>/environ.
 *
 * CỐ Ý không dùng 'systemctl show -p Environment': nó chỉ cho biết unit KHAI
 * BÁO gì, trong khi napp đặt NODE_OPTIONS TRƯỚC EnvironmentFile nên '.env' của
 * app ghi đè được. Ở đây sai một li là đi một dặm: nếu cờ
 * '--heapsnapshot-signal' không thực sự có hiệu lực thì SIGUSR2 rơi về hành vi
 * mặc định của tiến trình — GIẾT nó. Chẩn đoán rò rỉ mà làm sập app production
 * là kịch bản tệ nhất có thể.
 */
function liveNodeOptions(pid: number): string | undefined {
  const p = `/proc/${pid}/environ`;
  if (!existsSync(p)) return undefined;
  try {
    for (const kv of readFileSync(p, "utf8").split("\0")) {
      if (kv.startsWith("NODE_OPTIONS=")) return kv.slice("NODE_OPTIONS=".length);
    }
    return ""; // đọc được environ nhưng không có biến -> chắc chắn KHÔNG có cờ
  } catch {
    return undefined; // không đọc được -> KHÔNG kết luận, và sẽ từ chối gửi tín hiệu
  }
}

/** Byte trống của phân vùng chứa `dir`. */
function freeBytes(dir: string): number | undefined {
  const res = execCapture("df", ["-B1", "--output=avail", dir]);
  if (res.code !== 0) return undefined;
  const n = parseInt(res.stdout.trim().split("\n").pop() ?? "", 10);
  return Number.isFinite(n) ? n : undefined;
}

function snapshotsIn(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((f) => f.endsWith(".heapsnapshot")));
  } catch {
    return new Set();
  }
}

export async function cmdMemSnapshot(id: string, opts: { yes?: boolean } = {}): Promise<void> {
  requireRoot();
  const ref = allUnits().find((u) => u.id === id || u.unit === id);
  if (!ref) die(`Không tìm thấy app/service '${id}'. Xem danh sách: napp app list · napp service list`);

  const m = readUnitMemory(ref!);
  if (!m.active || !m.mainPid) die(`'${id}' không chạy (hoặc không lấy được PID) — không có heap nào để chụp.`);

  const st = loadState();
  const workDir = st.apps[ref!.id]
    ? unitWorkDir(st.apps[ref!.id]!.webRoot, st.apps[ref!.id]!.appDir)
    : unitWorkDir(st.services[ref!.id]!.workDir, st.services[ref!.id]!.appDir);

  // --- CHẶN AN TOÀN: không có cờ thì SIGUSR2 sẽ GIẾT tiến trình -------------
  const nodeOpts = liveNodeOptions(m.mainPid!);
  if (nodeOpts === undefined) {
    die(
      `Không đọc được /proc/${m.mainPid}/environ nên KHÔNG thể xác nhận cờ '--heapsnapshot-signal'.\n` +
        `  napp TỪ CHỐI gửi SIGUSR2: nếu cờ đó không có hiệu lực, tín hiệu này GIẾT tiến trình.`
    );
  }
  if (!nodeOpts!.includes("--heapsnapshot-signal=SIGUSR2")) {
    die(
      `'${id}' đang chạy KHÔNG có cờ '--heapsnapshot-signal=SIGUSR2'.\n` +
        `  Gửi SIGUSR2 lúc này sẽ GIẾT tiến trình (hành vi mặc định), nên napp dừng lại ở đây.\n` +
        `  NODE_OPTIONS đang có hiệu lực: ${nodeOpts || "(rỗng)"}\n` +
        `  Bật rồi khởi động lại app:\n` +
        `    sudo napp app update ${id} --leak-guard      (hoặc: napp service update ${id} --leak-guard)\n` +
        `  Nếu bạn ĐÃ bật mà vẫn thấy dòng này: '.env' của app đang đặt NODE_OPTIONS và ghi đè cấu hình của napp\n` +
        `  (napp cố ý đặt NODE_OPTIONS TRƯỚC EnvironmentFile để bạn ghi đè được).`
    );
  }

  // --- Dung lượng đĩa: file snapshot lớn khoảng 2x heap ---------------------
  const need = (m.anonBytes ?? 0) * 2.5;
  const avail = freeBytes(workDir);
  if (avail !== undefined && need > 0 && avail < need) {
    die(
      `Không đủ chỗ trống. Heap hiện ~${mb(m.anonBytes)}, file snapshot thường lớn GẤP ~2 LẦN heap ` +
        `(đo thực tế: 47 MB -> 82 MB · 96 MB -> 184 MB · 128 MB -> 237 MB), cần ~${mb(need)} nhưng chỉ còn ${mb(avail)} ở ${workDir}.`
    );
  }

  section(`Chụp heap snapshot: ${id}`);
  info(`Đơn vị     : ${m.unit} (PID ${m.mainPid})`);
  info(`Heap hiện  : ${mb(m.anonBytes)} -> file ước tính ~${mb((m.anonBytes ?? 0) * 2)}`);
  info(`Ghi vào    : ${workDir} (thư mục làm việc của app — Node luôn ghi vào CWD, không đổi được)`);
  warn(
    `Việc này KHÔNG NHANH. Đo trên máy thật: heap 96 MB -> file 184 MB, mất 176 GIÂY để ghi xong.\n` +
      `  V8 dừng tiến trình để duyệt heap, rồi ghi ra đĩa; heap càng lớn càng lâu.\n` +
      `  Với app web đang phục vụ traffic: chạy vào giờ thấp điểm, hoặc chụp worker trước.\n` +
      `  ĐỪNG restart/stop đơn vị trong lúc đang ghi — file sẽ CỤT và không phân tích được.`
  );

  if (!opts.yes) {
    const ans = await ask("Tiếp tục? [y/N] ");
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  const before = snapshotsIn(workDir);
  runCmd("kill", ["-USR2", String(m.mainPid)]);

  // Chờ file XUẤT HIỆN, rồi chờ KÍCH THƯỚC NGỪNG TĂNG. Không có bước thứ hai
  // thì rất dễ đem đi phân tích một file mới ghi được một nửa — nó vẫn là JSON
  // đọc được nên hỏng theo kiểu im lặng.
  let file: string | undefined;
  for (let i = 0; i < 60 && !file; i++) {
    sleepMs(1000);
    file = [...snapshotsIn(workDir)].find((f) => !before.has(f));
  }
  if (!file) {
    die(`Sau 60s vẫn không thấy file .heapsnapshot nào trong ${workDir}. Kiểm tra tiến trình còn sống không: systemctl status ${m.unit}`);
  }

  const full = `${workDir}/${file}`;
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 900 && stable < 3; i++) {
    sleepMs(1000);
    const cur = statSync(full).size;
    stable = cur === prev && cur > 0 ? stable + 1 : 0;
    prev = cur;
  }
  if (stable < 3) warn("Kích thước file vẫn đang thay đổi sau 15 phút — có thể chưa ghi xong, hãy kiểm tra lại trước khi phân tích.");

  // Chuyển ra khỏi thư mục mã nguồn: file rất to, và để nguyên trong cây mã
  // nguồn thì lần deploy sau có thể vướng hoặc vô tình đem theo.
  ensureDir(HEAPSNAP_DIR, 0o700);
  const dest = `${HEAPSNAP_DIR}/${ref!.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`;
  runCmd("mv", [full, dest]);
  runCmd("chmod", ["600", dest]);

  const sizeMB = Math.round(statSync(dest).size / 1048576);
  ok(`Đã chụp xong: ${dest} (${sizeMB} MB)`);
  info(`Tiến trình VẪN CHẠY (snapshot không làm app chết).`);
  console.log();
  info("Phân tích:");
  info(`  1. Tải về máy:  scp <server>:${dest} .`);
  info(`  2. Chrome > F12 > tab Memory > Load > chọn file`);
  info(`  3. Chụp LẦN HAI sau vài giờ, load cả hai, chọn 'Comparison' — thứ TĂNG giữa hai lần chính là chỗ rò rỉ.`);
  warn(`Nhớ xoá file khi xong: rm ${dest} (${sizeMB} MB)`);
}

/**
 * Bật/tắt hai cờ chẩn đoán rò rỉ của Node cho MỘT đơn vị.
 *
 * Tách khỏi 'app update' có chủ đích: đổi NODE_OPTIONS bắt buộc phải RESTART tiến
 * trình (Node chỉ đọc biến này lúc khởi động), mà 'app update' là lệnh sửa cấu hình
 * nginx và người dùng không chờ đợi nó làm app gián đoạn.
 */
export function cmdMemGuard(id: string, on: boolean): void {
  requireRoot();
  const st = loadState();
  const app = st.apps[id];
  const svc = st.services[id];
  if (!app && !svc) die(`Không tìm thấy app/service '${id}'.`);

  const runtime = (app ?? svc)!.nodeRuntime;
  if (runtime !== "node") {
    die(
      `'${id}' chạy bằng ${runtime}, không phải node. Hai cờ này là của V8 — bun dùng JavaScriptCore nên không hiểu.\n` +
        `  Với bun, hãy theo dõi bằng 'napp mem show --trend' (đo ở tầng cgroup nên runtime nào cũng được).`
    );
  }
  if (((app ?? svc)!.leakGuard ?? false) === on) {
    info(`'${id}' đã ở đúng trạng thái (leak-guard ${on ? "BẬT" : "TẮT"}) — không có gì để đổi.`);
    return;
  }

  const plan = currentHeapPlan();
  const unit = app ? `napp-${app.domain}` : `napp-svc-${svc!.name}`;
  if (app) {
    app.leakGuard = on;
    app.updatedAt = new Date().toISOString();
    upsertApp(app);
    writeAppUnit(app, plan.webMB);
  } else {
    svc!.leakGuard = on;
    svc!.updatedAt = new Date().toISOString();
    upsertService(svc!);
    writeServiceUnit(svc!, plan.serviceMB);
  }
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["restart", unit], { silentFail: true });

  if (!on) {
    ok(`Đã TẮT leak-guard cho '${id}' và khởi động lại.`);
    return;
  }
  ok(`Đã BẬT leak-guard cho '${id}' và khởi động lại.`);
  info(`• --heapsnapshot-near-heap-limit=1 : Node TỰ chụp heap ngay trước khi chết vì OOM, thay vì chết không để lại gì.`);
  info(`• --heapsnapshot-signal=SIGUSR2    : chụp theo yêu cầu bằng 'napp mem snapshot ${id}' (app vẫn chạy).`);
  warn(
    `File snapshot lớn khoảng GẤP ĐÔI heap và Node luôn ghi vào THƯ MỤC LÀM VIỆC của app (không đổi được chỗ).\n` +
      `  App rò rỉ tới trần 2 GB sẽ để lại một file ~4 GB ngay trong cây mã nguồn, và mất VÀI PHÚT để ghi\n` +
      `  (đo thực tế: heap 96 MB mất 176 giây). Theo dõi chỗ trống — 'napp mem show' sẽ báo khi thấy file sót lại.`
  );
  info(
    `Lưu ý: '--heapsnapshot-near-heap-limit' chụp khi SẮP chạm trần, và app thường VẪN CHẠY TIẾP sau đó ` +
      `(V8 gom rác rồi đi tiếp) — nên có file snapshot không đồng nghĩa app đã chết.`
  );
}

export function cmdMemWatchShow(): void {
  showTimer("Lấy mẫu bộ nhớ định kỳ", MEMWATCH_TIMER_NAME, "sudo napp mem watch enable --interval 15");
}

import { existsSync } from "node:fs";
import { ask as promptAsk, askBlock, PromptCancelled } from "../lib/prompt";
import { execCapture } from "../lib/exec";
import { cmdCheck } from "./check";
import { cmdDoctor, cmdDoctorSystem, cmdDoctorDeps, cmdDoctorUpgrade } from "./doctor";
import {
  cmdAppCreate,
  cmdAppDeploy,
  cmdAppRemove,
  cmdAppRestart,
  cmdAppStop,
  cmdAppStart,
  cmdAppLogs,
  cmdAppSet,
  cmdAppShow,
  cmdAppEnvList,
  cmdAppEnvSet,
  cmdAppEnvUnset,
  listAppSummaries,
} from "./app";
import {
  cmdServiceCreate,
  cmdServiceDeploy,
  cmdServiceRemove,
  cmdServiceRestart,
  cmdServiceStop,
  cmdServiceStart,
  cmdServiceLogs,
  cmdServiceShow,
  cmdServiceSet,
  cmdServiceEnvList,
  cmdServiceEnvSet,
  cmdServiceEnvUnset,
  listServiceSummaries,
} from "./service";
import type { Runtime, PackageManager } from "../lib/state";
import { getAcmeEmail, findUnit, getApp, getService, serviceNameFor, svcSystemdName, loadState } from "../lib/state";
import { cmdDomainAdd, cmdDomainRemove, cmdDomainList } from "./domain";
import { cmdCertIssue, cmdCertRenew, cmdCertList, cmdCertRevoke, cmdCertStatus } from "./cert";
import { cmdDbCreate, cmdDbList, cmdDbBackup, cmdDbDrop } from "./db";
import { cmdRedisAllocations, cmdRedisInfo, cmdRedisFlush } from "./redis";
import {
  cmdBackupRun,
  cmdBackupSchedule,
  cmdBackupList,
  cmdBackupUnschedule,
  cmdBackupScheduleShow,
  DEFAULT_RETENTION_DAYS,
  BACKUP_TIMER_NAME,
} from "./backup";
import {
  activeEngines,
  driverFor,
  DB_ENGINES,
  unitEngine,
  selectedEngines,
  setSelectedEngines,
  engineSelectionMade,
  unmanagedEngines,
  validateEngineSet,
  type DbEngine,
} from "../lib/db";
import { cmdDbEngineList, cmdDbEngineAdd, cmdDbEngineRemove, cmdDbEngineDefault } from "./dbengine";
import { cmdFirewallSync, cmdFirewallStatus } from "./firewall";
import { cmdFail2banSetup, cmdFail2banStatus, cmdFail2banUnban } from "./fail2ban";
import { cmdTuneApply, cmdTuneShow } from "./tune";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule, cmdCloudflareScheduleShow, CF_TIMER_NAME } from "./cloudflare";
import {
  cmdNginxHarden,
  cmdNginxUnharden,
  cmdNginxSync,
  cmdNginxScanBlock,
  cmdNginxUnscanBlock,
  nginxHardeningEnabled,
  scannerBlockEnabled,
} from "./nginx";
import { cmdMemStatus, cmdMemTrend, cmdMemWatch, cmdMemUnwatch, cmdMemWatchShow, cmdMemSnapshot, cmdMemGuard } from "./mem";
import { MEMWATCH_TIMER_NAME } from "../lib/memwatch";
import { timerState } from "../lib/timer";
import { cmdUpdate, cmdVersion, cmdChangelog } from "./update";
import { NAPP_VERSION } from "../version";
import { section, info, ok, warn, printDie, colorText, NappError } from "../lib/log";

async function ask(q: string): Promise<string> {
  return (await promptAsk(q)).trim();
}

async function askYesNo(q: string, def = false): Promise<boolean> {
  const ans = await ask(`${q} [${def ? "Y/n" : "y/N"}] `);
  if (!ans) return def;
  return /^y(es)?$/i.test(ans);
}

// Nhập deploy key: CHO PHÉP dán cả khối key nhiều dòng (đọc tiếp tới dòng
// '-----END ... PRIVATE KEY-----') HOẶC nhập một đường dẫn file trên 1 dòng.
// Trả về nội dung key (dán) hoặc đường dẫn (nhập tay) — cmdAppCreate tự phân
// biệt. Bắt buộc phải đọc nhiều dòng: readline chỉ lấy 1 dòng nên nếu chỉ
// dùng ask() thì key dán vào sẽ bị cắt cụt ở dòng '-----BEGIN' đầu tiên.
async function askSshKey(): Promise<string | undefined> {
  // Đọc cả khối trong MỘT lần hỏi: đóng/mở lại bộ đọc giữa hai dòng là mất
  // phần còn lại của lần dán.
  const lines = await askBlock(
    "Deploy key — DÁN nội dung key (bắt đầu '-----BEGIN'), hoặc nhập ĐƯỜNG DẪN file:\n",
    (first) => /^-----BEGIN /.test(first),
    (line) => /-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)
  );
  const first = (lines[0] ?? "").trim();
  if (!first) return undefined;
  if (!/^-----BEGIN /.test(first)) return first; // 1 dòng, không phải header key -> coi là đường dẫn
  return lines.join("\n");
}

// Cho người dùng chọn 1 giá trị từ danh sách bằng số thứ tự (hoặc gõ thẳng tên).
// Enter trống -> lấy mặc định.
async function askChoice<T extends string>(label: string, options: readonly T[], defaultValue: T): Promise<T> {
  console.log(`${label}:`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}${o === defaultValue ? "  (mặc định)" : ""}`));
  const ans = await ask(`Chọn [1-${options.length}] (Enter = ${defaultValue}): `);
  if (!ans) return defaultValue;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) {
    const picked = options[n - 1];
    if (picked !== undefined) return picked;
  }
  const byName = options.find((o) => o.toLowerCase() === ans.toLowerCase());
  if (byName) return byName;
  warn(`Lựa chọn không hợp lệ '${ans}' — dùng mặc định '${defaultValue}'.`);
  return defaultValue;
}

// Xổ danh sách app hiện có để người dùng CHỌN thay vì gõ tay domain. Trả về
// undefined nếu không có app nào, hoặc người dùng huỷ (0/Enter).
async function askAppDomain(actionLabel: string): Promise<string | undefined> {
  const apps = listAppSummaries();
  if (apps.length === 0) {
    warn("Chưa có app nào được napp quản lý — hãy tạo app trước (mục 'Tạo app mới').");
    return undefined;
  }
  console.log(`Chọn app để ${actionLabel}:`);
  apps.forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.domain.padEnd(30)} port=${a.port}  ${a.running ? "● đang chạy" : "○ đã dừng"}`)
  );
  const ans = await ask(`Chọn [1-${apps.length}] (0 = huỷ): `);
  if (!ans || ans === "0") return undefined;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= apps.length) {
    const picked = apps[n - 1];
    if (picked) return picked.domain;
  }
  const byName = apps.find((a) => a.domain === ans.trim());
  if (byName) return byName.domain;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

// Xổ danh sách background service hiện có để CHỌN thay vì gõ tay tên. Trả về
// undefined nếu không có service nào, hoặc người dùng huỷ (0/Enter).
async function askServiceName(actionLabel: string): Promise<string | undefined> {
  const services = listServiceSummaries();
  if (services.length === 0) {
    warn("Chưa có background service nào — hãy tạo service trước (mục 'Tạo service mới').");
    return undefined;
  }
  console.log(`Chọn service để ${actionLabel}:`);
  services.forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.name.padEnd(30)} ${s.port !== undefined ? `port=${s.port}` : "no-port"}  ${s.running ? "● đang chạy" : "○ đã dừng"}`)
  );
  const ans = await ask(`Chọn [1-${services.length}] (0 = huỷ): `);
  if (!ans || ans === "0") return undefined;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= services.length) {
    const picked = services[n - 1];
    if (picked) return picked.name;
  }
  const byName = services.find((s) => s.name === ans.trim());
  if (byName) return byName.name;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

// Chọn một engine trong số engine napp đang quản lý. Chỉ có một -> trả luôn,
// không hỏi. undefined = không có engine nào.
async function askEngine(actionLabel: string): Promise<DbEngine | undefined> {
  const engines = activeEngines();
  if (engines.length === 0) {
    warn("Chưa có database engine nào được cài — thêm ở menu Quản lý Database > Thêm database engine.");
    return undefined;
  }
  if (engines.length === 1) return engines[0];
  return askChoice<DbEngine>(`Database engine để ${actionLabel}`, engines, engines[0]!);
}

// Xổ danh sách database (mọi engine) để chọn. Trả về {engine, name}, "__ALL__"
// nếu chọn tất cả, hoặc undefined nếu huỷ / không có DB nào.
async function askDatabase(actionLabel: string): Promise<{ engine: DbEngine; name: string } | "__ALL__" | undefined> {
  const dbs = activeEngines().flatMap((engine) => driverFor(engine).list().map((name) => ({ engine, name })));
  if (dbs.length === 0) {
    warn("Không tìm thấy database nào (hoặc database engine chưa chạy / chưa kết nối được).");
    return undefined;
  }
  console.log(`Chọn database để ${actionLabel}:`);
  dbs.forEach((d, i) => console.log(`  ${i + 1}. ${d.name}  (${driverFor(d.engine).label})`));
  console.log(`  a. TẤT CẢ database`);
  const ans = (await ask(`Chọn [1-${dbs.length} / a = tất cả] (0 = huỷ): `)).trim();
  if (!ans || ans === "0") return undefined;
  if (ans.toLowerCase() === "a") return "__ALL__";
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= dbs.length) return dbs[n - 1];
  const byName = dbs.find((d) => d.name === ans);
  if (byName) return byName;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

// Chọn NHIỀU tuỳ chọn bằng cách bật/tắt (tick) theo số thứ tự. Mỗi tuỳ chọn có
// trạng thái mặc định (đã tick hay chưa); người dùng gõ các số để đảo trạng thái,
// Enter trống = xác nhận danh sách đang hiển thị. Trả về Set các key đang bật.
async function askMultiSelect(
  label: string,
  options: readonly { key: string; label: string; default: boolean }[]
): Promise<Set<string>> {
  const selected = new Set(options.filter((o) => o.default).map((o) => o.key));
  while (true) {
    console.log(`${label}`);
    options.forEach((o, i) => console.log(`  ${i + 1}. [${selected.has(o.key) ? "x" : " "}] ${o.label}`));
    const ans = await ask(`Gõ số để bật/tắt (cách nhau bởi dấu cách/phẩy), Enter = xác nhận: `);
    if (!ans) return selected;
    for (const tok of ans.split(/[\s,]+/).filter(Boolean)) {
      const n = parseInt(tok, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        const key = options[n - 1]!.key;
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
      } else {
        warn(`Bỏ qua lựa chọn không hợp lệ: '${tok}'`);
      }
    }
    console.log();
  }
}

// Hỏi số ngày retention, mặc định DEFAULT_RETENTION_DAYS.
async function askRetentionDays(): Promise<number> {
  const ans = (await ask(`Giữ backup trong bao nhiêu NGÀY (retention, mặc định ${DEFAULT_RETENTION_DAYS}): `)).trim();
  const n = parseInt(ans, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

// Thông báo in ngay dưới menu ở lần vẽ kế tiếp. Cần vì printMenu xoá màn hình:
// in thẳng ra lúc đó thì người dùng không kịp đọc.
let notice: string | undefined;

function printMenu(title: string, items: string[], exitLabel = "Quay lại", header?: string[]): void {
  console.clear();
  section(title);
  if (header?.length) {
    for (const line of header) console.log(`  ${line}`);
    console.log();
  }
  items.forEach((label, i) => console.log(`  ${i + 1}. ${label}`));
  console.log(`  0. ${exitLabel}`);
  console.log();
  if (notice) {
    console.log(notice);
    console.log();
    notice = undefined;
  }
}

/** Chờ Enter trước khi vẽ lại menu (menu xoá màn hình). Ctrl+C ở đây = bỏ qua. */
async function pause(): Promise<void> {
  try {
    await ask("\nNhấn Enter để quay lại menu...");
  } catch (e) {
    if (e instanceof PromptCancelled && e.reason === "sigint") return;
    throw e;
  }
}

/**
 * In lỗi RÕ RÀNG rồi để menu chạy tiếp — không bao giờ để lỗi của một lệnh
 * (thường là lệnh bên thứ ba: apt, git, certbot, systemctl...) đá người dùng
 * ra khỏi napp mà không để lại manh mối nào.
 */
function reportError(e: unknown): void {
  console.error();
  if (e instanceof NappError) {
    // die() của napp: thông báo đã viết sẵn cho người dùng, kèm cách sửa.
    printDie(e.message);
  } else if (["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException)?.code ?? "")) {
    printDie(`Không đủ quyền: ${(e as Error).message}\n  Mở napp bằng quyền root: sudo napp`);
  } else if ((e as NodeJS.ErrnoException)?.code === "ENOSPC") {
    printDie(`Hết dung lượng đĩa: ${(e as Error).message}\n  Dọn bớt (vd: sudo journalctl --vacuum-size=200M, sudo apt-get clean) rồi thử lại.`);
  } else {
    // Không phải lỗi napp chủ động báo -> là lỗi của chính napp. Nói thẳng ra và
    // đưa đủ thông tin để báo lại, thay vì một dòng khó hiểu.
    const err = e instanceof Error ? e : new Error(String(e));
    printDie(`Lỗi không mong đợi trong napp: ${err.message}`);
    const stack = (err.stack ?? "").split("\n").slice(1, 7).join("\n");
    if (stack) console.error(colorText("dim", stack));
    console.error("  Đây là lỗi của napp. Hãy báo lại kèm các dòng trên: https://github.com/anhtuank7c/napp/issues");
  }
  console.error(colorText("dim", "  napp vẫn đang chạy — xử lý theo hướng dẫn ở trên rồi thử lại từ menu."));
}

/** Chạy một lệnh từ menu: lỗi gì cũng được báo rõ và quay lại menu. */
async function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PromptCancelled) {
      if (e.reason === "eof") throw e; // stdin đã đóng: không còn ai để hỏi -> runMenu thoát có lời
      notice = colorText("dim", "Đã huỷ.");
      return;
    }
    reportError(e);
  }
  await pause();
}

/**
 * Vào một menu con. Ctrl+C tại câu hỏi "Chọn:" của menu con = quay về menu
 * chính. Lỗi lọt ra ngoài guard (không nên có — đây là lưới an toàn cuối) được
 * báo rõ thay vì làm sập cả napp.
 */
async function submenu(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PromptCancelled) {
      if (e.reason === "eof") throw e;
      return;
    }
    reportError(e);
    await pause();
  }
}

// ==========================================================================
// Khung menu: mỗi màn hình là MỘT ngữ cảnh (một nhóm, hoặc một app/service cụ
// thể đã chọn). Danh sách mục được dựng lại MỖI LẦN vẽ, nên nhãn luôn phản ánh
// trạng thái thật: [BẬT]/[TẮT], ● đang chạy / ○ đã dừng, số lượng app...
// ==========================================================================

interface Item {
  label: string;
  run: () => unknown;
  /** true = mở một menu con (không dừng "Nhấn Enter" sau khi quay lại). */
  open?: boolean;
}

interface Screen {
  title: string;
  header?: string[];
  items: Item[];
}

/**
 * Vòng lặp chung cho mọi menu con: đánh số, '0'/Enter = quay lại, lựa chọn sai
 * được báo ngay dưới menu. Mục hành động chạy qua guard (lỗi báo rõ, quay lại
 * menu), mục mở menu con chạy qua submenu. `screen` trả undefined = ngữ cảnh
 * không còn (vd app vừa bị xoá) -> tự quay lại menu cha.
 */
async function menuLoop(screen: () => Screen | undefined): Promise<void> {
  while (true) {
    const s = screen();
    if (!s) return;
    printMenu(
      s.title,
      s.items.map((i) => (i.open ? `${i.label} ›` : i.label)),
      "Quay lại",
      s.header
    );
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    const n = Number(choice);
    const item = Number.isInteger(n) ? s.items[n - 1] : undefined;
    if (!item) {
      notice = colorText("yellow", `Lựa chọn không hợp lệ: '${choice}'. Gõ số từ 0 đến ${s.items.length}.`);
      continue;
    }
    if (item.open) await submenu(async () => void (await item.run()));
    else await guard(async () => void (await item.run()));
  }
}

const state = (on: boolean) => (on ? colorText("green", "[BẬT]") : colorText("dim", "[TẮT]"));
const running = (on: boolean) => (on ? colorText("green", "● đang chạy") : colorText("yellow", "○ đã dừng"));

/** In lệnh CLI tương đương — người dùng menu học dần được lệnh để viết script. */
function cli(cmd: string): void {
  console.log(colorText("dim", `Lệnh tương đương: sudo napp ${cmd}`));
}

/** Một công tắc: hỏi xác nhận theo chiều sẽ đổi, rồi gọi hàm bật/tắt tương ứng. */
async function flip(what: string, on: boolean, enable: () => unknown, disable: () => unknown, cmdOn: string, cmdOff: string): Promise<void> {
  if (!(await askYesNo(`${on ? "TẮT" : "BẬT"} ${what}?`))) {
    info("Không thay đổi gì.");
    return;
  }
  cli(on ? cmdOff : cmdOn);
  await (on ? disable() : enable());
}

function unitRunning(systemdName: string): boolean {
  return execCapture("systemctl", ["is-active", "--quiet", systemdName]).code === 0;
}

/** Hỏi nhiều cặp KEY=VALUE, mỗi dòng một cặp (giá trị được phép có dấu cách). */
async function askEnvPairs(): Promise<string[]> {
  const pairs: string[] = [];
  console.log("Nhập từng biến dạng KEY=VALUE, mỗi dòng một biến. Enter trống = xong.");
  while (true) {
    const line = await ask(`  biến #${pairs.length + 1}: `);
    if (!line) return pairs;
    if (!line.includes("=")) {
      warn("Thiếu dấu '=' — bỏ qua dòng này.");
      continue;
    }
    pairs.push(line);
  }
}

/** Hỏi chọn một app HOẶC service (cho các thao tác áp dụng cho cả hai). */
async function askUnit(actionLabel: string): Promise<string | undefined> {
  const ids = [...listAppSummaries().map((a) => a.domain), ...listServiceSummaries().map((s) => s.name)];
  if (ids.length === 0) {
    warn("Chưa có app hay service nào.");
    return undefined;
  }
  console.log(`Chọn app/service để ${actionLabel}:`);
  ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
  const ans = await ask(`Chọn [1-${ids.length}] (0 = huỷ): `);
  const n = parseInt(ans, 10);
  if (!ans || ans === "0") return undefined;
  return Number.isInteger(n) && n >= 1 && n <= ids.length ? ids[n - 1] : ids.find((id) => id === ans);
}

// ------------------------------------------------------------ 1. Môi trường

/** Một dòng trạng thái cho từng engine napp đang quản lý (+ engine đã cài nhưng không quản lý). */
function engineStatusLines(): string[] {
  const selected = selectedEngines();
  const lines: string[] = [];
  if (selected.length === 0) {
    lines.push(`Database: ${colorText("dim", "không dùng (đã chọn)")}`);
  } else {
    const parts = selected.map((e) => {
      const d = driverFor(e);
      const st = !d.isInstalled() ? colorText("yellow", "✗ chưa cài") : d.isRunning() ? colorText("green", "● đang chạy") : colorText("yellow", "○ đã dừng");
      return `${d.label} ${st}`;
    });
    lines.push(`Database cần có: ${parts.join(" · ")}${engineSelectionMade() ? "" : colorText("dim", "  (chưa từng chọn — mặc định MariaDB)")}`);
  }
  const unmanaged = unmanagedEngines();
  if (unmanaged.length) lines.push(colorText("dim", `Đã cài nhưng napp không quản lý: ${unmanaged.map((e) => driverFor(e).label).join(", ")}`));
  return lines;
}

/**
 * Chọn lại tập engine cần có trên máy. Bỏ tick một engine đang cài thì HỎI:
 * gỡ khỏi máy, hay chỉ ngừng quản lý (engine vẫn chạy). Tick thêm thì cài luôn.
 * Gỡ chạy TRƯỚC thêm: đổi MariaDB -> MySQL phải gỡ cái cũ trước, không thì apt
 * xung đột (và driver sẽ từ chối cài).
 */
async function chooseEnginesFlow(): Promise<void> {
  const current = selectedEngines();
  const sel = await askMultiSelect("Database engine cần có trên máy ([x] = cần có; bỏ hết = không dùng database):", [
    ...DB_ENGINES.map((e) => ({
      key: e,
      label: `${driverFor(e).label}${driverFor(e).isInstalled() ? colorText("dim", " — đã cài") : ""}${e === "mariadb" || e === "mysql" ? colorText("dim", " (MariaDB và MySQL chỉ chọn một)") : ""}`,
      default: current.includes(e),
    })),
  ]);
  const next = DB_ENGINES.filter((e) => sel.has(e));
  validateEngineSet(next);
  const adding = next.filter((e) => !current.includes(e));
  const removing = current.filter((e) => !next.includes(e));
  if (adding.length === 0 && removing.length === 0) {
    // Vẫn ghi lại nếu đây là lần đầu chọn: chốt mặc định thành lựa chọn tường minh.
    if (!engineSelectionMade()) setSelectedEngines(next);
    return info("Không thay đổi gì.");
  }
  console.log();
  if (removing.length) info(`Bỏ: ${removing.map((e) => driverFor(e).label).join(", ")}`);
  if (adding.length) info(`Thêm (sẽ cài nếu chưa có): ${adding.map((e) => driverFor(e).label).join(", ")}`);
  if (!(await askYesNo("Tiếp tục?"))) return info("Không thay đổi gì.");

  for (const e of removing) {
    const d = driverFor(e);
    if (d.isInstalled() && (await askYesNo(`Gỡ ${d.label} khỏi máy? (dữ liệu được GIỮ; 'không' = chỉ ngừng quản lý, ${d.label} vẫn chạy)`))) {
      cli(`db engine delete ${e}`);
      await cmdDbEngineRemove(e, { purge: false, force: false, yes: true });
    } else {
      cli(`db engine set ${selectedEngines().filter((x) => x !== e).join(",") || "none"}`);
      setSelectedEngines(selectedEngines().filter((x) => x !== e));
      ok(`napp ngừng quản lý ${d.label}.`);
    }
  }
  if (adding.length) {
    cli(`db engine create ${adding.join(" ")}`);
    await cmdDbEngineAdd(adding, { yes: false });
  } else if (next.length === 0) {
    setSelectedEngines([]); // bỏ hết = chủ động không dùng database
  }
}

async function menuCheck(): Promise<void> {
  await menuLoop(() => ({
    title: "Kiểm tra & sửa môi trường",
    header: engineStatusLines(),
    items: [
      { label: "Kiểm tra (chỉ xem, không thay đổi gì)", run: () => (cli("check"), cmdCheck({ fix: false, yes: false })) },
      { label: "Kiểm tra và TỰ CÀI / SỬA phần còn thiếu", run: () => (cli("check --fix"), cmdCheck({ fix: true, yes: false })) },
      { label: "Chọn database engine cần có trên máy (thêm / bỏ)", run: chooseEnginesFlow },
    ],
  }));
}

// ------------------------------------------------------------------ 2. App
async function createAppFlow(): Promise<void> {
  const domain = await ask("Domain (vd: api.example.com): ");
  if (!domain) return;
  const repo = await ask("Git repo URL (bỏ trống nếu chưa có): ");
  // Repo PRIVATE cần xác thực trước — nếu không sẽ treo ở prompt nhập
  // username/password (HTTPS) hoặc yes/no host-key (SSH). Hỏi ngay tại đây.
  let token: string | undefined;
  let sshKey: string | undefined;
  if (repo && (await askYesNo("Repo này có PRIVATE (cần xác thực) không?"))) {
    if (/^https?:\/\//i.test(repo)) token = (await ask("Personal Access Token (HTTPS): ")) || undefined;
    else sshKey = await askSshKey();
  }
  const runtime = await askChoice<Runtime>("Runtime engine", ["node", "bun"], "node");
  const pmDefault: PackageManager = runtime === "bun" ? "bun" : "npm";
  const packageManager = await askChoice<PackageManager>("Trình quản lý gói phụ thuộc", ["npm", "pnpm", "yarn", "bun"], pmDefault);
  const dbEngine = (await askYesNo("Tạo database riêng cho app này?")) ? await askEngine("tạo database") : undefined;
  const redis = await askYesNo("Cấp Redis DB riêng cho app này?");
  // Hỏi thay vì bật ngầm: napp chiếm tiền tố URL bằng 'location ^~', thứ thắng
  // cả proxy_pass. Người dùng phải BIẾT điều đó đang xảy ra.
  const autoStatic = await askYesNo("Cho nginx trả thẳng asset tĩnh nếu nhận diện được framework (nhanh hơn nhiều)?");
  await cmdAppCreate(domain, {
    repo: repo || undefined,
    branch: "main",
    token,
    sshKey,
    runtime,
    packageManager,
    db: dbEngine !== undefined,
    dbEngine,
    redis,
    autoStatic,
    env: [],
  });
}

async function menuApps(): Promise<void> {
  await menuLoop(() => {
    const apps = listAppSummaries();
    return {
      title: `App web (${apps.length})`,
      header: apps.length === 0 ? ["Chưa có app nào — chọn 1 để tạo app đầu tiên."] : undefined,
      items: [
        { label: "Tạo app mới", run: createAppFlow },
        ...apps.map((a) => ({
          label: `${a.domain.padEnd(32)} ${running(a.running)}`,
          run: () => appContext(a.domain),
          open: true,
        })),
      ],
    };
  });
}

async function appContext(domain: string): Promise<void> {
  await menuLoop(() => {
    const app = getApp(domain);
    if (!app) return undefined; // vừa bị xoá
    const up = unitRunning(serviceNameFor(domain));
    const ssl = existsSync(`/etc/letsencrypt/live/${domain}`);
    return {
      title: `App ${domain}`,
      header: [
        `${running(up)} · 127.0.0.1:${app.port} · ${app.nodeRuntime}/${app.packageManager ?? "npm"} · ` +
          `SSL: ${ssl ? "có" : "chưa"} · DB: ${app.dbName ? `${unitEngine(app)} '${app.dbName}'` : "-"} · Redis: ${app.redisDbIndex !== undefined ? `#${app.redisDbIndex}` : "-"}`,
      ],
      items: [
        { label: "Xem chi tiết", run: () => (cli(`app show ${domain}`), cmdAppShow(domain)) },
        { label: "Deploy (git pull + build + restart)", run: () => (cli(`app deploy ${domain}`), cmdAppDeploy(domain)) },
        { label: "Khởi động lại", run: () => (cli(`app restart ${domain}`), cmdAppRestart(domain)) },
        up
          ? { label: "Dừng app", run: () => (cli(`app stop ${domain}`), cmdAppStop(domain)) }
          : { label: "Khởi động app", run: () => (cli(`app start ${domain}`), cmdAppStart(domain)) },
        { label: "Xem log (100 dòng)", run: () => (cli(`app logs ${domain} -n 100`), cmdAppLogs(domain, { follow: false, lines: 100 })) },
        { label: "Biến môi trường (.env)", run: () => envMenu("app", domain), open: true },
        { label: `Domain phụ (${app.aliasDomains.length})`, run: () => aliasMenu(domain), open: true },
        { label: `SSL`, run: () => appSslMenu(domain), open: true },
        { label: "Nginx: asset tĩnh · file tải lên · hotlink · giới hạn upload", run: () => appNginxMenu(domain), open: true },
        {
          label: `${state(Boolean(app.leakGuard))} Leak guard — tự chụp heap trước khi chết vì hết bộ nhớ`,
          run: () =>
            flip(
              `leak guard cho '${domain}' (app sẽ RESTART một lần)`,
              Boolean(app.leakGuard),
              () => cmdMemGuard(domain, true),
              () => cmdMemGuard(domain, false),
              `mem guard enable ${domain}`,
              `mem guard disable ${domain}`
            ),
        },
        { label: "Chụp heap snapshot ngay (app vẫn chạy)", run: () => (cli(`mem snapshot ${domain}`), cmdMemSnapshot(domain)) },
        { label: colorText("red", "Xoá app"), run: () => deleteAppFlow(domain) },
      ],
    };
  });
}

async function deleteAppFlow(domain: string): Promise<void> {
  // Mặc định tick sẵn nginx + ssl; mã nguồn + database là tuỳ chọn (giữ dữ liệu).
  const sel = await askMultiSelect(`Chọn những gì cần xoá khi gỡ app '${domain}' ([x] = sẽ xoá; service systemd luôn bị gỡ):`, [
    { key: "nginx", label: "Cấu hình domain nginx", default: true },
    { key: "ssl", label: "Chứng chỉ SSL", default: true },
    { key: "source", label: "Mã nguồn (và user hệ thống)", default: false },
    { key: "database", label: "Database", default: false },
  ]);
  if (!(await askYesNo(`Xác nhận gỡ app '${domain}' (không thể hoàn tác)?`))) return info("Không thay đổi gì.");
  cli(`app delete ${domain} -y${sel.has("source") ? " --source" : ""}${sel.has("database") ? " --database" : ""}${sel.has("nginx") ? "" : " --keep-nginx"}${sel.has("ssl") ? "" : " --keep-ssl"}`);
  await cmdAppRemove(domain, { yes: true, nginx: sel.has("nginx"), ssl: sel.has("ssl"), source: sel.has("source"), database: sel.has("database") });
}

async function envMenu(kind: "app" | "service", id: string): Promise<void> {
  await menuLoop(() => ({
    title: `Biến môi trường — ${kind} ${id}`,
    header: [colorText("dim", `Sửa xong cần khởi động lại ${kind} để có hiệu lực.`)],
    items: [
      {
        label: "Xem (giá trị bí mật bị che)",
        run: () => (cli(`${kind} env list ${id}`), kind === "app" ? cmdAppEnvList(id, { reveal: false }) : cmdServiceEnvList(id, { reveal: false })),
      },
      {
        label: "Xem cả giá trị bí mật",
        run: () => (cli(`${kind} env list ${id} --reveal`), kind === "app" ? cmdAppEnvList(id, { reveal: true }) : cmdServiceEnvList(id, { reveal: true })),
      },
      {
        label: "Đặt / sửa biến",
        run: async () => {
          const pairs = await askEnvPairs();
          if (pairs.length === 0) return info("Không có biến nào — không thay đổi gì.");
          cli(`${kind} env set ${id} ${pairs.map((p) => `'${p}'`).join(" ")}`);
          if (kind === "app") cmdAppEnvSet(id, pairs);
          else cmdServiceEnvSet(id, pairs);
        },
      },
      {
        label: "Xoá biến",
        run: async () => {
          const keys = (await ask("Tên biến cần xoá (cách nhau dấu cách): ")).split(/\s+/).filter(Boolean);
          if (keys.length === 0) return info("Không thay đổi gì.");
          cli(`${kind} env unset ${id} ${keys.join(" ")}`);
          if (kind === "app") cmdAppEnvUnset(id, keys);
          else cmdServiceEnvUnset(id, keys);
        },
      },
    ],
  }));
}

async function aliasMenu(domain: string): Promise<void> {
  await menuLoop(() => {
    const app = getApp(domain);
    if (!app) return undefined;
    return {
      title: `Domain phụ — ${domain}`,
      header: [app.aliasDomains.length ? `Hiện có: ${app.aliasDomains.join(", ")}` : "Chưa có domain phụ nào."],
      items: [
        { label: "Xem", run: () => (cli(`app alias list ${domain}`), cmdDomainList(domain)) },
        {
          label: "Thêm domain phụ",
          run: async () => {
            const alias = await ask("Domain phụ (vd: www.example.com): ");
            if (!alias) return;
            cli(`app alias create ${domain} ${alias}`);
            await cmdDomainAdd(domain, alias);
          },
        },
        {
          label: "Gỡ domain phụ",
          run: async () => {
            if (app.aliasDomains.length === 0) return info("Không có domain phụ nào để gỡ.");
            const alias = await askChoice("Domain phụ cần gỡ", app.aliasDomains, app.aliasDomains[0]!);
            cli(`app alias delete ${domain} ${alias}`);
            await cmdDomainRemove(domain, alias);
          },
        },
      ],
    };
  });
}

async function appSslMenu(domain: string): Promise<void> {
  await menuLoop(() => ({
    title: `SSL — ${domain}`,
    header: [existsSync(`/etc/letsencrypt/live/${domain}`) ? "Đã có chứng chỉ." : "Chưa có chứng chỉ."],
    items: [
      { label: "Xem chứng chỉ", run: () => (cli(`cert show ${domain}`), cmdCertStatus(domain)) },
      {
        label: "Cấp chứng chỉ",
        run: async () => {
          const saved = getAcmeEmail();
          const email = (await ask(`Email Let's Encrypt${saved ? ` (Enter = ${saved})` : " (Enter = đăng ký KHÔNG email)"}: `)) || saved || "";
          cli(`cert create ${domain}${email ? ` --email ${email}` : " --register-without-email"}`);
          await cmdCertIssue(domain, { noWww: false, extra: [], email: email || undefined, registerWithoutEmail: !email, redirect: true });
        },
      },
      { label: "Gia hạn", run: () => (cli(`cert renew ${domain}`), cmdCertRenew(domain, { force: false })) },
      {
        label: colorText("red", "Thu hồi & xoá chứng chỉ"),
        run: async () => {
          if (!(await askYesNo(`Thu hồi & xoá chứng chỉ của '${domain}'? Website sẽ mất HTTPS tới khi cấp lại.`))) return info("Không thay đổi gì.");
          cli(`cert delete ${domain} -y`);
          await cmdCertRevoke(domain, { yes: true });
        },
      },
    ],
  }));
}

async function appNginxMenu(domain: string): Promise<void> {
  await menuLoop(() => {
    const app = getApp(domain);
    if (!app) return undefined;
    const set = (flags: string, opts: Parameters<typeof cmdAppSet>[1]) => {
      cli(`app update ${domain} ${flags}`);
      cmdAppSet(domain, opts);
    };
    return {
      title: `Nginx — ${domain}`,
      header: [
        `Asset tĩnh: ${app.staticRoot ?? (app.staticAliases?.length ? "alias" : "-")} · File tải lên: ${app.uploadDir ?? "-"} · Upload tối đa: ${app.maxBodySize ?? "20M"}`,
      ],
      items: [
        { label: "Tự nhận diện framework và cho nginx trả thẳng asset tĩnh", run: () => set("--auto-static", { autoStatic: true }) },
        {
          label: "Đặt thư mục asset tĩnh thủ công",
          run: async () => {
            const root = await ask(`Thư mục asset build (vd ${app.webRoot}/build/client): `);
            if (!root) return info("Không thay đổi gì.");
            const prefixes = (await ask("Tiền tố URL (cách nhau dấu cách, vd /_app/ /assets/): ")).split(/\s+/).filter(Boolean);
            set(`--static-root ${root} ${prefixes.map((p) => `--static-prefix ${p}`).join(" ")}`, { staticRoot: root, staticPrefix: prefixes.length ? prefixes : undefined });
          },
        },
        {
          label: "Thư mục file người dùng tải lên",
          run: async () => {
            const dir = await ask(`Thư mục tải lên (vd ${app.webRoot}/static/uploads): `);
            if (!dir) return info("Không thay đổi gì.");
            const prefix = (await ask("Tiền tố URL (Enter = /uploads/): ")) || undefined;
            set(`--upload-dir ${dir}${prefix ? ` --upload-prefix ${prefix}` : ""}`, { uploadDir: dir, uploadPrefix: prefix });
          },
        },
        {
          label: `${state(Boolean(app.hotlinkProtect))} Chặn hotlink ảnh/asset từ site khác`,
          run: () =>
            flip(
              "chặn hotlink",
              Boolean(app.hotlinkProtect),
              () => set("--hotlink-protect", { hotlinkProtect: true }),
              () => set("--no-hotlink-protect", { hotlinkProtect: false }),
              "",
              ""
            ),
        },
        {
          label: `Giới hạn kích thước upload (hiện: ${app.maxBodySize ?? "20M"})`,
          run: async () => {
            const size = await ask("Kích thước tối đa (vd 100M): ");
            if (!size) return info("Không thay đổi gì.");
            set(`--max-body ${size}`, { maxBody: size });
          },
        },
        {
          label: `${state(app.scanBlock !== false)} Chặn quét lỗ hổng PHP cho site này`,
          run: () =>
            flip(
              "chặn quét lỗ hổng cho site này",
              app.scanBlock !== false,
              () => set("--scan-block", { scanBlock: true }),
              () => set("--no-scan-block", { scanBlock: false }),
              "",
              ""
            ),
        },
      ],
    };
  });
}

// -------------------------------------------------------------- 3. Service
async function createServiceFlow(): Promise<void> {
  const name = await ask("Tên service (vd: worker-telegram, queue-email): ");
  if (!name) return;
  const repo = await ask("Git repo URL (bỏ trống nếu chưa có): ");
  let token: string | undefined;
  let sshKey: string | undefined;
  if (repo && (await askYesNo("Repo này có PRIVATE (cần xác thực) không?"))) {
    if (/^https?:\/\//i.test(repo)) token = (await ask("Personal Access Token (HTTPS): ")) || undefined;
    else sshKey = await askSshKey();
  }
  const startCmd = (await ask("Lệnh khởi động (Enter = 'npm start' theo package.json; vd: node worker.js): ")) || undefined;
  const runtime = await askChoice<Runtime>("Runtime engine", ["node", "bun"], "node");
  const pmDefault: PackageManager = runtime === "bun" ? "bun" : "npm";
  const packageManager = await askChoice<PackageManager>("Trình quản lý gói phụ thuộc", ["npm", "pnpm", "yarn", "bun"], pmDefault);
  let port: number | undefined;
  if (await askYesNo("Service có tự listen một cổng nội bộ không (health-check/socket)?")) {
    const p = parseInt(await ask("Cổng nội bộ (Enter = tự cấp 3000-3999): "), 10);
    if (Number.isInteger(p)) port = p;
  }
  // Worker "nửa kia của một app web" (nén ảnh, sinh thumbnail, dọn cache) phải
  // chạy BẰNG user của app đó mới đọc/ghi được file của nó — thư mục app là 750
  // của user riêng, user khác không vào nổi.
  let runAs: string | undefined;
  if (await askYesNo("Worker này có đọc/ghi FILE của một app web đã có không (nén ảnh, thumbnail, dọn cache)?")) {
    runAs = await askAppDomain("chạy chung user hệ thống (worker sẽ ghi được vào thư mục của app này)");
  }
  const dbEngine = (await askYesNo("Tạo database riêng cho service này?")) ? await askEngine("tạo database") : undefined;
  const redis = await askYesNo("Cấp Redis DB riêng cho service này?");
  // Dùng chung user gần như luôn đi kèm dùng chung hàng đợi. Chỉ hỏi khi app kia
  // thật sự có Redis DB, tránh dẫn người dùng vào lựa chọn chết.
  const sharedRedis = runAs ? findUnit(runAs)?.redisDbIndex : undefined;
  let shareRedisWith: string | undefined;
  if (redis && runAs && sharedRedis !== undefined) {
    if (await askYesNo(`Dùng CHUNG Redis DB #${sharedRedis} với '${runAs}' (BẮT BUỘC nếu worker tiêu thụ hàng đợi của app đó)?`, true)) {
      shareRedisWith = runAs;
    }
  }
  await cmdServiceCreate(name, {
    repo: repo || undefined,
    branch: "main",
    token,
    sshKey,
    startCmd,
    runtime,
    packageManager,
    port,
    db: dbEngine !== undefined,
    dbEngine,
    redis,
    shareRedisWith,
    runAs,
    writeDirs: [],
    env: [],
  });
}

async function menuServices(): Promise<void> {
  await menuLoop(() => {
    const services = listServiceSummaries();
    return {
      title: `Background service (${services.length})`,
      header: services.length === 0 ? ["Chưa có service nào — chọn 1 để tạo service đầu tiên."] : undefined,
      items: [
        { label: "Tạo service mới", run: createServiceFlow },
        ...services.map((s) => ({
          label: `${s.name.padEnd(32)} ${running(s.running)}`,
          run: () => serviceContext(s.name),
          open: true,
        })),
      ],
    };
  });
}

async function serviceContext(name: string): Promise<void> {
  await menuLoop(() => {
    const svc = getService(name);
    if (!svc) return undefined;
    const up = unitRunning(svcSystemdName(name));
    return {
      title: `Service ${name}`,
      header: [
        `${running(up)} · ${svc.nodeRuntime}/${svc.packageManager ?? "npm"} · user ${svc.user}${svc.runAsUnit ? ` (mượn của '${svc.runAsUnit}')` : ""} · ` +
          `DB: ${svc.dbName ? `${unitEngine(svc)} '${svc.dbName}'` : "-"} · Redis: ${svc.redisDbIndex !== undefined ? `#${svc.redisDbIndex}` : "-"}`,
      ],
      items: [
        { label: "Xem chi tiết", run: () => (cli(`service show ${name}`), cmdServiceShow(name)) },
        { label: "Deploy (git pull + build + restart)", run: () => (cli(`service deploy ${name}`), cmdServiceDeploy(name)) },
        { label: "Khởi động lại", run: () => (cli(`service restart ${name}`), cmdServiceRestart(name)) },
        up
          ? { label: "Dừng service", run: () => (cli(`service stop ${name}`), cmdServiceStop(name)) }
          : { label: "Khởi động service", run: () => (cli(`service start ${name}`), cmdServiceStart(name)) },
        { label: "Xem log (100 dòng)", run: () => (cli(`service logs ${name} -n 100`), cmdServiceLogs(name, { follow: false, lines: 100 })) },
        { label: "Biến môi trường (.env)", run: () => envMenu("service", name), open: true },
        { label: "Danh tính & quyền ghi (chạy bằng user nào, được ghi vào đâu)", run: () => serviceIdentityMenu(name), open: true },
        {
          label: `${state(Boolean(svc.leakGuard))} Leak guard — tự chụp heap trước khi chết vì hết bộ nhớ`,
          run: () =>
            flip(
              `leak guard cho '${name}' (service sẽ RESTART một lần)`,
              Boolean(svc.leakGuard),
              () => cmdMemGuard(name, true),
              () => cmdMemGuard(name, false),
              `mem guard enable ${name}`,
              `mem guard disable ${name}`
            ),
        },
        { label: "Chụp heap snapshot ngay (service vẫn chạy)", run: () => (cli(`mem snapshot ${name}`), cmdMemSnapshot(name)) },
        {
          label: colorText("red", "Xoá service"),
          run: async () => {
            const sel = await askMultiSelect(`Chọn những gì cần xoá khi gỡ service '${name}' ([x] = sẽ xoá; service systemd luôn bị gỡ):`, [
              { key: "source", label: "Mã nguồn (và user hệ thống)", default: false },
              { key: "database", label: "Database", default: false },
            ]);
            if (!(await askYesNo(`Xác nhận gỡ service '${name}' (không thể hoàn tác)?`))) return info("Không thay đổi gì.");
            cli(`service delete ${name} -y${sel.has("source") ? " --source" : ""}${sel.has("database") ? " --database" : ""}`);
            await cmdServiceRemove(name, { yes: true, source: sel.has("source"), database: sel.has("database") });
          },
        },
      ],
    };
  });
}

async function serviceIdentityMenu(name: string): Promise<void> {
  await menuLoop(() => {
    const svc = getService(name);
    if (!svc) return undefined;
    return {
      title: `Danh tính & quyền ghi — ${name}`,
      header: [
        `Chạy bằng: ${svc.user}${svc.runAsUnit ? ` (user của '${svc.runAsUnit}')` : " (user riêng)"}`,
        `Được ghi thêm vào: ${svc.writePaths?.length ? svc.writePaths.join(", ") : "-"}`,
      ],
      items: [
        {
          label: "Chạy bằng user của một app web (để đọc/ghi file của app đó)",
          run: async () => {
            const runAs = await askAppDomain("cho service mượn user");
            if (!runAs) return;
            cli(`service update ${name} --run-as ${runAs}`);
            await cmdServiceSet(name, { runAs, writeDirs: [] });
          },
        },
        { label: "Quay về user riêng (cô lập hoàn toàn)", run: () => (cli(`service update ${name} --standalone`), cmdServiceSet(name, { standalone: true, writeDirs: [] })) },
        {
          label: "Đặt lại các đường dẫn được ghi thêm",
          run: async () => {
            const dirs = (await ask("Đường dẫn tuyệt đối (cách nhau dấu cách): ")).split(/\s+/).filter(Boolean);
            if (dirs.length === 0) return info("Không thay đổi gì.");
            cli(`service update ${name} ${dirs.map((d) => `--write-dir ${d}`).join(" ")}`);
            await cmdServiceSet(name, { writeDirs: dirs });
          },
        },
        { label: "Bỏ hết đường dẫn ghi thêm", run: () => (cli(`service update ${name} --no-write-dir`), cmdServiceSet(name, { writeDirs: [], clearWriteDirs: true })) },
      ],
    };
  });
}

// ------------------------------------------------------------------ 4. SSL
async function menuCert(): Promise<void> {
  await menuLoop(() => ({
    title: "SSL (Let's Encrypt)",
    header: [colorText("dim", "Cấp / gia hạn / thu hồi chứng chỉ của MỘT app: vào App web › <domain> › SSL.")],
    items: [
      { label: "Danh sách chứng chỉ + hạn dùng", run: () => (cli("cert list"), cmdCertList()) },
      { label: "Gia hạn TẤT CẢ chứng chỉ sắp hết hạn", run: () => (cli("cert renew"), cmdCertRenew(undefined, { force: false })) },
    ],
  }));
}

// -------------------------------------------------------------- 5. Database
async function menuDb(): Promise<void> {
  await menuLoop(() => {
    const engines = activeEngines();
    return {
      title: "Database",
      header: [`Engine đang dùng: ${engines.length ? engines.join(", ") : "không có (vào Engine để thêm)"}`],
      items: [
        { label: "Danh sách database", run: () => (cli("db list"), cmdDbList()) },
        {
          label: "Tạo database",
          run: async () => {
            const engine = await askEngine("tạo database");
            if (!engine) return;
            const name = await ask("Tên database: ");
            if (!name) return;
            cli(`db create ${name} --engine ${engine}`);
            cmdDbCreate(name, { engine });
          },
        },
        {
          label: "Backup một database",
          run: async () => {
            const db = await askDatabase("backup");
            if (!db || db === "__ALL__") return;
            cli(`backup create --database ${db.name} --engine ${db.engine}`);
            cmdDbBackup(db.name, { engine: db.engine });
          },
        },
        {
          label: colorText("red", "Xoá database"),
          run: async () => {
            const db = await askDatabase("XOÁ");
            if (!db || db === "__ALL__") return;
            cli(`db delete ${db.name} --engine ${db.engine}`);
            await cmdDbDrop(db.name, { yes: false, engine: db.engine });
          },
        },
        { label: "Engine (MariaDB / MySQL / PostgreSQL / MongoDB)", run: menuDbEngine, open: true },
      ],
    };
  });
}

async function menuDbEngine(): Promise<void> {
  await menuLoop(() => ({
    title: "Database engine",
    items: [
      { label: "Xem: đã cài / đang chạy / app nào dùng", run: () => (cli("db engine list"), cmdDbEngineList()) },
      {
        label: "Thêm engine",
        run: async () => {
          const engine = await askChoice<DbEngine>("Engine muốn thêm", DB_ENGINES, "postgresql");
          cli(`db engine create ${engine}`);
          await cmdDbEngineAdd([engine], { yes: false });
        },
      },
      {
        label: "Đặt engine mặc định cho '--db'",
        run: async () => {
          const engines = activeEngines();
          if (engines.length === 0) return warn("Chưa có engine nào.");
          const engine = await askChoice<DbEngine>("Engine mặc định", engines, engines[0]!);
          cli(`db engine update ${engine} --default`);
          cmdDbEngineDefault(engine);
        },
      },
      {
        label: colorText("red", "Gỡ engine"),
        run: async () => {
          const engines = activeEngines();
          if (engines.length === 0) return warn("Không có engine nào để gỡ.");
          const engine = await askChoice<DbEngine>("Engine muốn gỡ", engines, engines[0]!);
          const purge = await askYesNo("XOÁ VĨNH VIỄN cả dữ liệu (--purge)? Chọn 'không' để giữ dữ liệu trên đĩa", false);
          const force = await askYesNo("Vẫn gỡ nếu còn database không gắn với app nào (napp dump toàn bộ trước)?", false);
          cli(`db engine delete ${engine}${purge ? " --purge" : ""}${force ? " --force" : ""}`);
          await cmdDbEngineRemove(engine, { purge, force, yes: false });
        },
      },
    ],
  }));
}

// ----------------------------------------------------------------- 6. Redis
async function menuRedis(): Promise<void> {
  await menuLoop(() => ({
    title: "Redis",
    items: [
      { label: "Xem bộ nhớ Redis", run: () => (cli("redis show"), cmdRedisInfo()) },
      { label: "DB index nào đang cấp cho app/service nào", run: () => (cli("redis db list"), cmdRedisAllocations()) },
      {
        label: colorText("red", "Xoá TOÀN BỘ dữ liệu của một DB index"),
        run: async () => {
          const n = parseInt(await ask("DB index (0-15): "), 10);
          if (!Number.isInteger(n)) return info("Không thay đổi gì.");
          cli(`redis db flush ${n}`);
          await cmdRedisFlush(n, { yes: false });
        },
      },
    ],
  }));
}

// ---------------------------------------------------------------- 7. Sao lưu
async function menuBackup(): Promise<void> {
  await menuLoop(() => ({
    title: "Sao lưu",
    header: [colorText("dim", "Backup tự động hàng ngày: xem ở 'Tác vụ định kỳ'.")],
    items: [
      {
        label: "Backup database ngay",
        run: async () => {
          const db = await askDatabase("backup");
          if (!db) return;
          const keepDays = await askRetentionDays();
          if (db === "__ALL__") {
            cli(`backup create --target db --keep-days ${keepDays}`);
            cmdBackupRun({ target: "db", keepDays });
          } else {
            cli(`backup create --target db --database ${db.name} --engine ${db.engine} --keep-days ${keepDays}`);
            cmdBackupRun({ target: "db", database: db.name, engine: db.engine, keepDays });
          }
        },
      },
      {
        label: "Backup mã nguồn ngay",
        run: async () => {
          const keepDays = await askRetentionDays();
          cli(`backup create --target files --keep-days ${keepDays}`);
          cmdBackupRun({ target: "files", keepDays });
        },
      },
      {
        label: "Backup TẤT CẢ ngay (database + mã nguồn)",
        run: async () => {
          const keepDays = await askRetentionDays();
          cli(`backup create --keep-days ${keepDays}`);
          cmdBackupRun({ target: "all", keepDays });
        },
      },
      { label: "Danh sách bản backup", run: () => (cli("backup list"), cmdBackupList()) },
    ],
  }));
}

// -------------------------------------------------------- 8. Tác vụ định kỳ
interface Schedule {
  label: string;
  timer: string;
  show: () => void;
  enable: () => Promise<void>;
  disable: () => void;
  cmd: string; // tiền tố lệnh CLI, vd "backup schedule"
}

const SCHEDULES: Schedule[] = [
  {
    label: "Backup hàng ngày",
    timer: BACKUP_TIMER_NAME,
    show: cmdBackupScheduleShow,
    cmd: "backup schedule",
    enable: async () => {
      const time = (await ask("Giờ chạy hàng ngày (HH:MM, Enter = 03:00): ")) || "03:00";
      const keepDays = await askRetentionDays();
      const target = await askChoice("Backup những gì", ["all", "db", "files"] as const, "all");
      cli(`backup schedule enable --time ${time} --keep-days ${keepDays} --target ${target}`);
      cmdBackupSchedule({ time, keepDays, target });
    },
    disable: cmdBackupUnschedule,
  },
  {
    label: "Cập nhật dải IP Cloudflare",
    timer: CF_TIMER_NAME,
    show: cmdCloudflareScheduleShow,
    cmd: "cloudflare schedule",
    enable: async () => {
      const time = (await ask("Giờ chạy hàng ngày (HH:MM, Enter = 01:00): ")) || "01:00";
      cli(`cloudflare schedule enable --time ${time}`);
      cmdCloudflareSchedule({ time });
    },
    disable: cmdCloudflareUnschedule,
  },
  {
    label: "Lấy mẫu bộ nhớ (phát hiện rò rỉ sớm)",
    timer: MEMWATCH_TIMER_NAME,
    show: cmdMemWatchShow,
    cmd: "mem watch",
    enable: async () => {
      const interval = parseInt((await ask("Lấy mẫu mỗi bao nhiêu phút (Enter = 15): ")) || "15", 10) || 15;
      cli(`mem watch enable --interval ${interval}`);
      cmdMemWatch({ interval });
    },
    disable: cmdMemUnwatch,
  },
];

function scheduleLabel(s: Schedule): string {
  const st = timerState(s.timer);
  const detail = st.exists ? [st.schedule, st.next ? `lần tới ${st.next}` : undefined].filter(Boolean).join(" · ") : "";
  return `${state(st.exists && st.enabled)} ${s.label}${detail ? colorText("dim", ` — ${detail}`) : ""}`;
}

async function menuSchedules(): Promise<void> {
  await menuLoop(() => ({
    title: "Tác vụ định kỳ (systemd timer)",
    header: [colorText("dim", "Mọi việc napp tự chạy theo lịch nằm ở đây.")],
    items: SCHEDULES.map((s) => ({ label: scheduleLabel(s), run: () => scheduleContext(s), open: true })),
  }));
}

async function scheduleContext(s: Schedule): Promise<void> {
  await menuLoop(() => {
    const st = timerState(s.timer);
    const on = st.exists && st.enabled;
    return {
      title: s.label,
      header: [scheduleLabel(s)],
      items: [
        { label: "Xem chi tiết (lịch, lần chạy tới/trước, lệnh được chạy)", run: () => (cli(`${s.cmd} show`), s.show()) },
        { label: on ? "Đổi lịch" : "Bật", run: s.enable },
        ...(st.exists ? [{ label: "Tắt", run: () => (cli(`${s.cmd} disable`), s.disable()) }] : []),
      ],
    };
  });
}

// --------------------------------------------------------------- 9. Bảo mật
async function menuSecurity(): Promise<void> {
  await menuLoop(() => {
    const hardening = nginxHardeningEnabled();
    const scanBlock = scannerBlockEnabled();
    return {
      title: "Bảo mật",
      items: [
        { label: "Tường lửa UFW", run: menuFirewall, open: true },
        { label: "fail2ban (tự ban IP brute-force / quét lỗ hổng)", run: menuFail2ban, open: true },
        {
          label: `${state(hardening)} Chặn truy cập bằng IP / Host lạ (nginx hardening)`,
          run: () => flip("chặn truy cập bằng IP/Host lạ", hardening, cmdNginxHarden, cmdNginxUnharden, "nginx hardening enable", "nginx hardening disable"),
        },
        {
          label: `${state(scanBlock)} Chặn quét lỗ hổng PHP/WordPress trên mọi site`,
          run: () => flip("chặn quét lỗ hổng trên mọi site", scanBlock, cmdNginxScanBlock, cmdNginxUnscanBlock, "nginx scan-block enable", "nginx scan-block disable"),
        },
        { label: "Quét bản vá & rủi ro dependencies (doctor)", run: menuDoctor, open: true },
      ],
    };
  });
}

async function menuFirewall(): Promise<void> {
  await menuLoop(() => ({
    title: "Tường lửa UFW",
    items: [
      { label: "Xem trạng thái", run: () => (cli("firewall show"), cmdFirewallStatus()) },
      {
        label: "Áp cấu hình (deny mặc định, mở SSH + 80/443)",
        run: () => (cli("firewall apply"), cmdFirewallSync({ restrictToCloudflare: false, extraPorts: [], yes: false })),
      },
    ],
  }));
}

async function menuFail2ban(): Promise<void> {
  await menuLoop(() => ({
    title: "fail2ban",
    items: [
      { label: "Xem các jail + IP đang bị chặn", run: () => (cli("fail2ban show"), cmdFail2banStatus()) },
      { label: "Áp cấu hình jail", run: () => (cli("fail2ban apply"), cmdFail2banSetup({})) },
      {
        label: "Gỡ chặn một IP",
        run: async () => {
          const jail = await ask("Tên jail (xem ở mục 1, vd sshd): ");
          const ip = await ask("IP: ");
          if (!jail || !ip) return info("Không thay đổi gì.");
          cli(`fail2ban unban ${jail} ${ip}`);
          cmdFail2banUnban(jail, ip);
        },
      },
    ],
  }));
}

async function menuDoctor(): Promise<void> {
  await menuLoop(() => ({
    title: "Quét bảo mật (doctor)",
    items: [
      {
        label: "Quét TẤT CẢ (bản vá hệ thống + dependencies)",
        run: async () => {
          const deep = await askYesNo("Tra thêm tuổi bản phát hành trên registry npm (cần mạng, chậm hơn)?", false);
          cli(`doctor${deep ? " --deep" : ""}`);
          await cmdDoctor({ refresh: true, audit: true, deep });
        },
      },
      { label: "Chỉ bản vá bảo mật của hệ thống", run: () => (cli("doctor system"), void cmdDoctorSystem({ refresh: true })) },
      { label: "Dependencies của MỌI app/service", run: async () => (cli("doctor deps"), void (await cmdDoctorDeps({ audit: true, deep: false }))) },
      {
        label: "Dependencies của MỘT app/service",
        run: async () => {
          const id = await askUnit("quét dependencies");
          if (!id) return;
          cli(`doctor deps ${id}`);
          await cmdDoctorDeps({ target: id, audit: true, deep: false });
        },
      },
      { label: "Cài bản vá BẢO MẬT ngay (apt + restart dịch vụ)", run: () => (cli("doctor upgrade"), cmdDoctorUpgrade({ all: false, only: [], yes: false, restart: true })) },
      { label: "Cài TẤT CẢ bản cập nhật đang chờ", run: () => (cli("doctor upgrade --all"), cmdDoctorUpgrade({ all: true, only: [], yes: false, restart: true })) },
    ],
  }));
}

// ------------------------------------------------------ 10. Hiệu năng & nginx
async function menuPerformance(): Promise<void> {
  await menuLoop(() => ({
    title: "Hiệu năng & nginx",
    items: [
      { label: "Xem đề xuất tối ưu theo phần cứng", run: () => (cli("tune show"), cmdTuneShow()) },
      { label: "Áp tối ưu (nginx / database / Redis / sysctl / heap Node)", run: () => (cli("tune apply"), cmdTuneApply({ yes: false, skipRestart: false, syncUnits: false })) },
      { label: "Đồng bộ cấu hình nginx vào vhost đã có (sửa 502 route sâu)", run: () => (cli("nginx apply"), cmdNginxSync()) },
      { label: "Cập nhật dải IP Cloudflare vào nginx ngay", run: () => (cli("cloudflare apply"), cmdCloudflareSync()) },
      { label: "Bộ nhớ & rò rỉ", run: menuMem, open: true },
    ],
  }));
}

async function menuMem(): Promise<void> {
  await menuLoop(() => ({
    title: "Bộ nhớ & rò rỉ",
    header: [colorText("dim", "Leak guard của từng app/service: vào menu của app/service đó. Lấy mẫu định kỳ: 'Tác vụ định kỳ'.")],
    items: [
      { label: "Bộ nhớ hiện tại + số lần âm thầm khởi động lại", run: () => (cli("mem show"), cmdMemStatus()) },
      { label: "Xu hướng (từ dữ liệu đã lấy mẫu)", run: () => (cli("mem show --trend"), cmdMemTrend()) },
      {
        label: "Chụp heap snapshot của một app/service",
        run: async () => {
          const id = await askUnit("chụp heap snapshot");
          if (!id) return;
          cli(`mem snapshot ${id}`);
          await cmdMemSnapshot(id);
        },
      },
    ],
  }));
}

// ------------------------------------------------------------------ 11. napp
async function menuNapp(): Promise<void> {
  await menuLoop(() => ({
    title: `napp v${NAPP_VERSION}`,
    items: [
      { label: "Cập nhật napp lên bản mới nhất", run: () => (cli("update"), cmdUpdate()) },
      { label: "Lịch sử thay đổi", run: () => cmdChangelog() },
      { label: "Phiên bản", run: () => cmdVersion() },
    ],
  }));
}

// ============================================================== Menu chính
function topItems(): Item[] {
  const apps = Object.keys(loadState().apps).length;
  const services = Object.keys(loadState().services).length;
  const scheduled = SCHEDULES.filter((s) => {
    const st = timerState(s.timer);
    return st.exists && st.enabled;
  }).length;
  return [
    { label: "Kiểm tra & sửa môi trường", run: menuCheck, open: true },
    { label: `App web (${apps})`, run: menuApps, open: true },
    { label: `Background service (${services})`, run: menuServices, open: true },
    { label: "SSL", run: menuCert, open: true },
    { label: "Database", run: menuDb, open: true },
    { label: "Redis", run: menuRedis, open: true },
    { label: "Sao lưu", run: menuBackup, open: true },
    { label: `Tác vụ định kỳ (${scheduled}/${SCHEDULES.length} đang bật)`, run: menuSchedules, open: true },
    { label: "Bảo mật", run: menuSecurity, open: true },
    { label: "Hiệu năng & nginx", run: menuPerformance, open: true },
    { label: "napp (cập nhật, phiên bản)", run: menuNapp, open: true },
  ];
}

export async function runMenu(): Promise<void> {
  // Ctrl+C khi một lệnh hệ thống đang chạy (git, apt, certbot...): terminal đang
  // ở chế độ thường nên tín hiệu tới CẢ lệnh con lẫn napp. Lệnh con dừng, lỗi
  // được báo qua guard; napp thì KHÔNG được chết theo — không có listener này
  // thì Node thoát ngay, không một dòng giải thích.
  const onSigint = () => {
    process.stdout.write("\n");
    warn("Ctrl+C: đã gửi tín hiệu ngắt tới lệnh đang chạy. napp không thoát — sẽ quay lại menu khi lệnh dừng.");
  };
  // Lưới an toàn cuối: lỗi bắn ra từ callback bất đồng bộ (không nằm trong
  // await nào của menu) — báo rõ, menu vẫn chạy.
  const onCrash = (e: unknown) => {
    reportError(e);
    notice = colorText("yellow", "Vừa có lỗi ngoài dự kiến (xem phía trên trước khi menu vẽ lại).");
  };
  process.on("SIGINT", onSigint);
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  let lastSigint = 0;
  try {
    while (true) {
      const items = topItems();
      printMenu(
        `napp v${NAPP_VERSION} — Quản lý server Node.js`,
        items.map((i) => `${i.label} ›`),
        "Thoát napp"
      );
      let choice: string;
      try {
        choice = await ask("Chọn: ");
      } catch (e) {
        if (!(e instanceof PromptCancelled) || e.reason === "eof") throw e;
        // Ctrl+C ở menu chính: lần đầu chỉ nhắc (bấm nhầm là chuyện thường), lần
        // thứ hai trong 3 giây mới thoát.
        if (Date.now() - lastSigint < 3000) break;
        lastSigint = Date.now();
        notice = colorText("yellow", "Chọn 0 để thoát napp (hoặc bấm Ctrl+C lần nữa trong 3 giây).");
        continue;
      }
      // CHỈ thoát khi chủ đích chọn 0/q. Trước đây Enter trống cũng thoát — bấm
      // nhầm một phím là văng khỏi napp.
      if (choice === "0" || choice.toLowerCase() === "q") break;
      if (choice === "") continue;
      const n = Number(choice);
      const item = Number.isInteger(n) ? items[n - 1] : undefined;
      if (item) await submenu(async () => void (await item.run()));
      else notice = colorText("yellow", `Lựa chọn không hợp lệ: '${choice}'. Gõ số từ 0 đến ${items.length}.`);
    }
    info("Đã thoát napp.");
  } catch (e) {
    // stdin đã đóng (Ctrl+D, SSH rớt, chạy qua pipe hết dữ liệu): không còn ai
    // để hỏi nên thoát — nhưng thoát CÓ LỜI, không lặng lẽ.
    if (e instanceof PromptCancelled) info("Đầu vào đã đóng — thoát napp.");
    else throw e;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("uncaughtException", onCrash);
    process.off("unhandledRejection", onCrash);
  }
}

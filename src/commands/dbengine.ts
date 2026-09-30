import { requireRoot, ensureDir, runCmd } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { detectHardware } from "../lib/hardware";
import { loadState, saveState } from "../lib/state";
import {
  DB_ENGINES,
  driverFor,
  parseEngine,
  parseEngineList,
  selectedEngines,
  setSelectedEngines,
  installedEngines,
  engineSelectionMade,
  unitEngine,
  validateEngineSet,
  type DbEngine,
} from "../lib/db";
import { dbBackupDir } from "./db";
import { cmdTuneApply } from "./tune";

async function ask(question: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(question);
  rl.close();
  return ans.trim();
}

/** App/service đang dùng database của engine này (theo registry). */
function unitsUsing(engine: DbEngine): string[] {
  const s = loadState();
  return [
    ...Object.values(s.apps)
      .filter((a) => a.dbName && unitEngine(a) === engine)
      .map((a) => `app ${a.domain} (db ${a.dbName})`),
    ...Object.values(s.services)
      .filter((v) => v.dbName && unitEngine(v) === engine)
      .map((v) => `service ${v.name} (db ${v.dbName})`),
  ];
}

export function cmdDbEngineList(): void {
  const selected = new Set(selectedEngines());
  const def = loadState().defaultDbEngine;
  section("Database engine");
  console.log(`  ${"engine".padEnd(12)} ${"napp quản lý".padEnd(13)} ${"đã cài".padEnd(8)} ${"đang chạy".padEnd(10)} ${"số DB".padEnd(6)} dùng bởi`);
  for (const e of DB_ENGINES) {
    const d = driverFor(e);
    const installed = d.isInstalled();
    const running = installed && d.isRunning();
    const count = running && d.canConnectAsAdmin() ? String(d.list().length) : "-";
    const users = unitsUsing(e);
    const managed = selected.has(e) ? (installed ? "có" : "có (CHƯA CÀI)") : installed ? "KHÔNG" : "-";
    console.log(
      `  ${(e + (def === e ? "*" : "")).padEnd(12)} ${managed.padEnd(13)} ${(installed ? "có" : "-").padEnd(8)} ${(running ? "có" : installed ? "ĐÃ DỪNG" : "-").padEnd(10)} ${count.padEnd(6)} ${users.length > 0 ? users.join(", ") : "-"}`
    );
  }
  console.log();
  if (!engineSelectionMade()) info("Chưa chọn engine lần nào — napp dùng mặc định: mariadb.");
  if (def) info(`* = engine mặc định cho '--db' không kèm tên.`);
  const unmanaged = installedEngines().filter((e) => !selected.has(e));
  if (unmanaged.length > 0) {
    info(`Đã cài nhưng napp không quản lý (không tune, không backup, không tự cài lại): ${unmanaged.join(", ")}. Nhận quản lý: napp db engine create <engine>`);
  }
  info("Thêm: napp db engine create <engine> · Gỡ: napp db engine delete <engine> · Hỗ trợ: " + DB_ENGINES.join(", "));
}

// Sau khi tập engine đổi, phần RAM của database được chia lại (và heap Node đổi
// theo). Áp ngay nghĩa là RESTART các DB và app — không làm lén: hỏi, hoặc in
// lệnh cho người dùng tự chạy lúc thấp điểm.
async function offerRetune(yes: boolean): Promise<void> {
  const hint = "Chạy 'sudo napp tune apply' (lúc thấp điểm) để chia lại RAM cho database + heap Node — lệnh này restart DB và các app.";
  if (yes || !process.stdin.isTTY) {
    info(hint);
    return;
  }
  const ans = await ask("Tập database engine đã đổi — cân đối lại RAM ngay bây giờ (restart DB + app)? [y/N] ");
  if (/^y(es)?$/i.test(ans)) await cmdTuneApply({ yes: true, skipRestart: false, syncUnits: false });
  else info(hint);
}

export async function cmdDbEngineAdd(rawEngines: string[], opts: { default?: boolean; yes: boolean }): Promise<void> {
  requireRoot();
  const adding = rawEngines.map(parseEngine);
  const next = [...new Set([...selectedEngines(), ...adding])];
  validateEngineSet(next);
  // Kể cả engine KHÔNG do napp quản lý: cài MySQL lên máy đang có MariaDB là
  // apt gỡ MariaDB đi cùng dữ liệu của nó.
  validateEngineSet([...new Set([...installedEngines(), ...adding])]);

  const hw = detectHardware();
  const heavy = next.length >= 2 && hw.tier === "micro";
  const mongoSmall = adding.includes("mongodb") && (hw.tier === "micro" || hw.tier === "small");
  if (heavy || mongoSmall) {
    warn(
      `Máy này chỉ có ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM (tier ${hw.tier}). ` +
        (mongoSmall ? "MongoDB cần tối thiểu ~1-2 GB để chạy thoải mái. " : "") +
        (heavy ? `Chạy ${next.length} database engine cùng lúc sẽ chia nhỏ RAM cho DB và các app Node. ` : "") +
        "Cân nhắc chỉ giữ một engine."
    );
    if (!opts.yes && process.stdin.isTTY && !/^y(es)?$/i.test(await ask("Vẫn tiếp tục? [y/N] "))) {
      info("Đã huỷ. Không thay đổi gì.");
      return;
    }
  }

  for (const e of adding) {
    const d = driverFor(e);
    if (!d.isInstalled()) {
      d.install();
    } else {
      if (!d.isRunning()) {
        info(`${d.label} đã cài nhưng chưa chạy — đang khởi động...`);
        runCmd("systemctl", ["enable", "--now", d.unit()]);
      }
      d.adopt?.();
      ok(`${d.label} đã cài và đang chạy — napp nhận quản lý.`);
    }
  }
  setSelectedEngines(next);
  if (opts.default) {
    if (adding.length !== 1) die("--default chỉ dùng khi thêm đúng MỘT engine.");
    const s = loadState();
    s.defaultDbEngine = adding[0];
    saveState(s);
  }
  ok(`Database engine napp quản lý: ${next.join(", ")}`);
  await offerRetune(opts.yes);
}

export async function cmdDbEngineRemove(raw: string, opts: { purge: boolean; force: boolean; yes: boolean }): Promise<void> {
  requireRoot();
  const engine = parseEngine(raw);
  const d = driverFor(engine);

  const users = unitsUsing(engine);
  if (users.length > 0) {
    die(
      `Không gỡ ${d.label}: còn ${users.length} đơn vị đang dùng database của nó:\n` +
        users.map((u) => `  - ${u}`).join("\n") +
        `\n  Gỡ các đơn vị đó trước (napp app delete <domain> --database / napp service delete <name> --database).`
    );
  }

  const installed = d.isInstalled();
  if (installed) {
    // Database không gắn với app nào (tạo bằng 'napp db create' hoặc tay): KHÔNG
    // âm thầm bỏ lại hay xoá. Bắt --force, và dump toàn bộ trước khi gỡ.
    const reachable = d.isRunning() && d.canConnectAsAdmin();
    const orphans = reachable ? d.list() : [];
    if (orphans.length > 0 || (!reachable && opts.purge)) {
      if (!opts.force) {
        die(
          (orphans.length > 0
            ? `${d.label} còn ${orphans.length} database: ${orphans.join(", ")}.\n`
            : `${d.label} không chạy nên napp không kiểm tra được còn dữ liệu hay không.\n`) +
            `  Thêm --force để tiếp tục${reachable ? " (napp sẽ dump TOÀN BỘ vào " + dbBackupDir(engine) + " trước khi gỡ)" : ""}.`
        );
      }
      if (reachable) {
        const dir = dbBackupDir(engine);
        ensureDir(dir, 0o750);
        const out = `${dir}/pre-remove-${new Date().toISOString().replace(/[:.]/g, "-")}${d.dumpExt}`;
        info(`Đang dump toàn bộ ${d.label} trước khi gỡ...`);
        d.dumpAll(out); // lỗi -> die, KHÔNG gỡ tiếp
        ok(`Đã lưu: ${out}`);
      }
    }

    if (opts.purge) {
      warn(`--purge: XOÁ VĨNH VIỄN gói, cấu hình VÀ THƯ MỤC DỮ LIỆU của ${d.label}.`);
      if (!(opts.yes && opts.force)) {
        const typed = await ask(`Gõ '${engine}' để xác nhận: `);
        if (typed !== engine) {
          info("Không khớp — đã huỷ. Không thay đổi gì.");
          return;
        }
      }
    } else if (!opts.yes) {
      const ans = await ask(`Gỡ ${d.label}? Dữ liệu và cấu hình được GIỮ LẠI (cài lại là dùng tiếp). [y/N] `);
      if (!/^y(es)?$/i.test(ans)) {
        info("Đã huỷ. Không thay đổi gì.");
        return;
      }
    }
    d.uninstall({ purge: opts.purge });
    ok(opts.purge ? `Đã gỡ sạch ${d.label}.` : `Đã gỡ ${d.label} (dữ liệu vẫn nằm trên đĩa).`);
  } else {
    info(`${d.label} không được cài trên máy này.`);
  }

  // Bỏ khỏi lựa chọn -> 'check --fix' sẽ KHÔNG cài lại.
  setSelectedEngines(selectedEngines().filter((e) => e !== engine));
  const left = selectedEngines();
  ok(`Database engine napp quản lý: ${left.length > 0 ? left.join(", ") : "(không có)"}`);
  if (installed) await offerRetune(opts.yes);
}

export function cmdDbEngineDefault(raw: string): void {
  requireRoot();
  const engine = parseEngine(raw);
  if (!selectedEngines().includes(engine)) die(`${engine} chưa nằm trong các engine napp quản lý. Thêm trước: napp db engine create ${engine}`);
  const s = loadState();
  s.dbEngines ??= selectedEngines();
  s.defaultDbEngine = engine;
  saveState(s);
  ok(`Engine mặc định cho '--db': ${engine}`);
}

/** Chỉ GHI NHẬN lựa chọn (không cài gì) — 'napp check --fix' sẽ cài theo. Dùng bởi install.sh (NAPP_DB). */
export function cmdDbEngineSelect(raw: string): void {
  requireRoot();
  const engines = parseEngineList(raw);
  setSelectedEngines(engines);
  ok(`Đã ghi nhận database engine: ${engines.length > 0 ? engines.join(", ") : "không dùng database"}`);
  const missing = engines.filter((e) => !driverFor(e).isInstalled());
  if (missing.length > 0) info(`Chưa cài: ${missing.join(", ")} — chạy 'sudo napp check --fix' để cài.`);
}

import { requireRoot, ensureDir, state as execState } from "../lib/exec";
import { ask, askSecret } from "../lib/prompt";
import { validateDbName } from "../lib/validate";
import { info, ok, die, section, warn } from "../lib/log";
import { resolveEngine, driverFor, installedEngines, unitEngine, type DbDriver, type DbEngine } from "../lib/db";
import { randomPassword } from "../lib/db/common";
import { BACKUP_ROOT, loadState } from "../lib/state";
import { parseEnvFile, mergeEnvFile } from "../lib/envfile";
import { unitWorkDir } from "../templates/systemd";
import { rollingRestart, appInstanceRefs, serviceInstanceRefs, type InstanceRef } from "../lib/instances";

export function dbBackupDir(engine: string): string {
  return `${BACKUP_ROOT}/db/${engine}`;
}

export function cmdDbCreate(name: string, opts: { user?: string; engine?: string }): void {
  requireRoot();
  const engine = resolveEngine(opts.engine);
  const driver = driverFor(engine);
  validateDbName(name, driver.maxNameLength);
  const user = opts.user ?? name;
  validateDbName(user, driver.maxNameLength);
  const created = driver.create(name, user);
  const env = driver.envFor(created);
  ok(`Đã tạo database ${driver.label} '${created.name}' + user '${created.user}'`);
  console.log(`  Mật khẩu     : ${created.password}`);
  console.log(`  DATABASE_URL : ${env.DATABASE_URL}`);
  console.log("  HÃY LƯU MẬT KHẨU NÀY NGAY — nó chỉ hiển thị một lần duy nhất.");
}

export async function cmdDbDrop(name: string, opts: { yes: boolean; user?: string; engine?: string }): Promise<void> {
  requireRoot();
  const engine = resolveEngine(opts.engine);
  const driver = driverFor(engine);
  validateDbName(name, driver.maxNameLength);
  if (!opts.yes) {
    const ans = await ask(`Xoá database ${driver.label} '${name}' vĩnh viễn? Hành động không thể hoàn tác. [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }
  driver.drop(name, opts.user);
  ok(`Đã xoá database ${driver.label} '${name}'.`);
}

export function cmdDbList(opts: { engine?: string } = {}): void {
  const engines = opts.engine ? [resolveEngine(opts.engine)] : installedEngines();
  if (engines.length === 0) {
    info("Chưa có database engine nào được cài. Xem: napp db engine list");
    return;
  }
  for (const engine of engines) {
    const driver = driverFor(engine);
    if (!driver.canConnectAsAdmin()) {
      warn(`${driver.label}: không kết nối được bằng quyền quản trị (chưa chạy?) — bỏ qua.`);
      continue;
    }
    const names = driver.list();
    section(`${driver.label} (${names.length})`);
    for (const n of names) console.log(`  - ${n}`);
  }
}

export function cmdDbBackup(name: string, opts: { engine?: string } = {}): void {
  requireRoot();
  const engine = resolveEngine(opts.engine);
  const driver = driverFor(engine);
  validateDbName(name, driver.maxNameLength);
  if (!driver.exists(name)) die(`Database ${driver.label} '${name}' không tồn tại.`);
  const dir = dbBackupDir(engine);
  ensureDir(dir, 0o750);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `${dir}/${name}-${ts}${driver.dumpExt}`;
  info(`Đang dump database ${driver.label} '${name}'...`);
  driver.dump(name, outPath);
  ok(`Đã lưu backup tại ${outPath}`);
}

// --- Đổi mật khẩu user CSDL ---------------------------------------------------

// Mật khẩu tự đặt: chỉ ký tự "unreserved" của URL. Nhờ vậy nó nhúng thẳng được
// vào DATABASE_URL (không percent-encode), vào chuỗi SQL '...', vào JSON của
// mongosh và vào .env mà không cần escape — cùng lý do mật khẩu ngẫu nhiên là hex.
const CUSTOM_PASSWORD = /^[A-Za-z0-9._~-]{16,128}$/;

export function validateCustomPassword(pw: string): void {
  if (!CUSTOM_PASSWORD.test(pw)) {
    die("Mật khẩu không hợp lệ: cần 16-128 ký tự, chỉ gồm chữ, số và . _ ~ - (để nhúng an toàn vào DATABASE_URL/.env/SQL).");
  }
}

interface LinkedUnit {
  kind: "app" | "service";
  id: string;
  user: string;
  envPath: string;
  refs: InstanceRef[];
}

// Khoá chứa URL kết nối có mật khẩu (napp ghi vào .env khi tạo --db).
const URL_KEYS = ["DATABASE_URL", "MONGODB_URI"];

/**
 * App/service đang dùng database này: theo registry (tạo bằng --db), HOẶC .env
 * trỏ vào đúng database + user + cổng của engine (worker tự chép cấu hình DB
 * của web app — kiểu dùng chung hay gặp). Bỏ sót đơn vị nào là đơn vị đó mất
 * kết nối ở lần restart kế, nên quét cả hai nguồn.
 */
function linkedUnits(driver: DbDriver, name: string, user: string): LinkedUnit[] {
  const s = loadState();
  const out: LinkedUnit[] = [];
  const consider = (
    kind: LinkedUnit["kind"],
    id: string,
    rec: { dbName?: string; dbUser?: string; dbEngine?: DbEngine; user: string },
    root: string,
    appDir: string | undefined,
    refs: InstanceRef[]
  ): void => {
    const envPath = `${unitWorkDir(root, appDir)}/.env`;
    const byRegistry = rec.dbName === name && unitEngine(rec) === driver.engine && (rec.dbUser ?? rec.dbName) === user;
    let byEnv = false;
    if (!byRegistry) {
      try {
        const env = parseEnvFile(envPath);
        byEnv = env.DB_DATABASE === name && env.DB_USERNAME === user && env.DB_PORT === String(driver.port);
      } catch {
        byEnv = false; // .env là symlink — parseEnvFile từ chối; không đụng vào
      }
    }
    if (byRegistry || byEnv) out.push({ kind, id, user: rec.user, envPath, refs });
  };
  for (const a of Object.values(s.apps)) consider("app", a.domain, a, a.webRoot, a.appDir, appInstanceRefs(a));
  for (const v of Object.values(s.services)) consider("service", v.name, v, v.workDir, v.appDir, serviceInstanceRefs(v));
  return out;
}

/**
 * Giá trị .env mới: DB_PASSWORD + thay ĐÚNG phần mật khẩu trong các URL kết nối
 * đang có — giữ nguyên tham số người dùng tự thêm (?connection_limit=5,
 * ?sslmode=..., host khác...). URL của user khác (không phải user đang đổi) thì
 * không đụng.
 */
export function envPasswordUpdates(env: Record<string, string>, user: string, password: string): { updates: Record<string, string>; skipped: string[] } {
  const updates: Record<string, string> = {};
  const skipped: string[] = [];
  if ("DB_PASSWORD" in env || !URL_KEYS.some((k) => k in env)) updates.DB_PASSWORD = password;
  for (const k of URL_KEYS) {
    const raw = env[k];
    if (raw === undefined || raw === "") continue;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      skipped.push(k);
      continue;
    }
    if (decodeURIComponent(u.username) !== user) {
      skipped.push(k);
      continue;
    }
    u.password = password;
    updates[k] = u.toString();
  }
  return { updates, skipped };
}

export async function cmdDbPassword(
  name: string,
  opts: { user?: string; engine?: string; custom?: boolean; restart?: boolean; yes?: boolean }
): Promise<void> {
  requireRoot();
  const engine = resolveEngine(opts.engine);
  const driver = driverFor(engine);
  validateDbName(name, driver.maxNameLength);

  // User mặc định: user trong registry của app/service dùng database này, rồi
  // tới tên database (đúng quy ước của 'db create' và '--db').
  const s = loadState();
  const rec = [...Object.values(s.apps), ...Object.values(s.services)].find((r) => r.dbName === name && unitEngine(r) === engine);
  const user = opts.user ?? rec?.dbUser ?? name;
  validateDbName(user, driver.maxNameLength);

  if (!execState.dryRun) {
    if (!driver.canConnectAsAdmin()) die(`Không kết nối được ${driver.label} bằng quyền quản trị (service có đang chạy?).`);
    if (!driver.userExists(name, user)) {
      die(
        `${driver.label} không có user '${user}'${engine === "mongodb" ? ` trong database '${name}'` : ""}.` +
          (opts.user ? "" : " Chỉ định user bằng --user <user>.")
      );
    }
  }

  const units = linkedUnits(driver, name, user);
  const restart = opts.restart !== false;

  section(`Đổi mật khẩu user ${driver.label} '${user}' (database '${name}')`);
  if (units.length) {
    console.log(`  .env sẽ được cập nhật: ${units.map((u) => `${u.kind} ${u.id}`).join(", ")}`);
    console.log(
      restart
        ? "  Sau đó các đơn vị trên được khởi động lại (cuốn chiếu nếu nhiều instance)."
        : "  KHÔNG restart (--no-restart): kết nối đang mở vẫn sống, nhưng kết nối MỚI sẽ lỗi cho tới khi bạn restart."
    );
  } else {
    console.log("  Không app/service nào của napp dùng database này — mật khẩu mới chỉ in ra màn hình MỘT lần.");
  }
  console.log("  Ứng dụng/công cụ NGOÀI napp đang dùng mật khẩu cũ (máy khác, GUI, cron...) sẽ không đăng nhập được nữa.");

  let password: string;
  if (opts.custom) {
    password = (await askSecret("Mật khẩu mới (16-128 ký tự: chữ, số, . _ ~ -): ")).trim();
    validateCustomPassword(password);
    if (process.stdin.isTTY && (await askSecret("Nhập lại: ")).trim() !== password) die("Hai lần nhập không khớp. Không thay đổi gì.");
  } else {
    password = randomPassword();
  }

  if (!opts.yes && !/^y(es)?$/i.test((await ask("Tiếp tục? [y/N] ")).trim())) {
    info("Đã huỷ. Không thay đổi gì.");
    return;
  }

  // Đọc .env TRƯỚC khi đổi: biết mật khẩu cũ để hoàn tác nếu ghi .env lỗi.
  const plans = units.map((u) => {
    const env = parseEnvFile(u.envPath);
    return { unit: u, oldPassword: env.DB_PASSWORD, ...envPasswordUpdates(env, user, password) };
  });

  driver.setPassword(name, user, password);
  if (execState.dryRun) return;
  ok(`Đã đổi mật khẩu user ${driver.label} '${user}'.`);

  const written: typeof plans = [];
  try {
    for (const p of plans) {
      mergeEnvFile(p.unit.envPath, p.updates, 0o600, p.unit.user);
      written.push(p);
    }
  } catch (e) {
    // Đưa database về mật khẩu cũ (lấy từ .env) để app đang chạy — và lần restart
    // kế — vẫn kết nối được. Không biết mật khẩu cũ thì in mật khẩu mới để tự sửa.
    const old = plans.find((p) => p.oldPassword)?.oldPassword;
    if (old && written.length === 0) {
      driver.setPassword(name, user, old);
      die(`Ghi .env thất bại (${(e as Error).message}). Đã đặt lại mật khẩu CŨ cho '${user}' — không có gì thay đổi.`);
    }
    die(
      `Ghi .env thất bại (${(e as Error).message}). Mật khẩu MỚI đã có hiệu lực: ${password}\n` +
        `  Sửa tay DB_PASSWORD/DATABASE_URL trong .env của: ${plans.filter((p) => !written.includes(p)).map((p) => p.unit.id).join(", ")}`
    );
  }

  for (const p of plans) {
    ok(`Đã cập nhật .env của ${p.unit.kind} '${p.unit.id}' (${Object.keys(p.updates).join(", ")}).`);
    if (p.skipped.length) {
      warn(`${p.unit.id}: KHÔNG sửa ${p.skipped.join(", ")} (không phải URL của user '${user}' hoặc không đọc được) — tự kiểm tra lại.`);
    }
  }

  if (restart) {
    for (const p of plans) {
      rollingRestart(p.unit.refs, p.unit.id);
      ok(`Đã khởi động lại ${p.unit.kind} '${p.unit.id}'.`);
    }
  } else if (plans.length) {
    info(`Nhớ restart: ${plans.map((p) => `napp ${p.unit.kind} restart ${p.unit.id}`).join(" ; ")}`);
  }

  if (plans.length === 0) {
    const env = driver.envFor({ name, user, password });
    console.log(`  Mật khẩu     : ${password}`);
    console.log(`  DATABASE_URL : ${env.DATABASE_URL}`);
    console.log("  HÃY LƯU MẬT KHẨU NÀY NGAY — nó chỉ hiển thị một lần duy nhất.");
  }
}

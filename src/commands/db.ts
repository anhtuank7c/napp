import { requireRoot, ensureDir } from "../lib/exec";
import { ask } from "../lib/prompt";
import { validateDbName } from "../lib/validate";
import { info, ok, die, section, warn } from "../lib/log";
import { resolveEngine, driverFor, installedEngines } from "../lib/db";
import { BACKUP_ROOT } from "../lib/state";

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

import { execCapture, runCmd, requireRoot, ensureDir } from "../lib/exec";
import { validateDbName } from "../lib/validate";
import { info, ok, die, section } from "../lib/log";
import { createDatabase, dropDatabase, dbExists, mysqlBin, dumpDatabase } from "../lib/mysql";
import { BACKUP_ROOT } from "../lib/state";

export function cmdDbCreate(name: string, userOpt?: string): void {
  requireRoot();
  validateDbName(name);
  const user = userOpt ?? name;
  validateDbName(user);
  const created = createDatabase(name, user);
  ok(`Đã tạo database '${created.name}' + user '${created.user}'@'localhost'`);
  console.log(`  Mật khẩu: ${created.password}`);
  console.log("  HÃY LƯU MẬT KHẨU NÀY NGAY — nó chỉ hiển thị một lần duy nhất.");
}

export async function cmdDbDrop(name: string, opts: { yes: boolean; user?: string }): Promise<void> {
  requireRoot();
  validateDbName(name);
  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Xoá database '${name}' vĩnh viễn? Hành động không thể hoàn tác. [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }
  dropDatabase(name, opts.user);
  ok(`Đã xoá database '${name}'.`);
}

export function cmdDbList(): void {
  const bin = mysqlBin();
  const res = execCapture(bin, [
    "-N",
    "-e",
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') ORDER BY SCHEMA_NAME",
  ]);
  if (res.code !== 0) die(`Không liệt kê được database: ${res.stderr}`);
  const names = res.stdout.trim().split("\n").filter(Boolean);
  section(`Database (${names.length})`);
  for (const n of names) console.log(`  - ${n}`);
}

export function cmdDbBackup(name: string): void {
  requireRoot();
  validateDbName(name);
  if (!dbExists(name)) die(`Database '${name}' không tồn tại.`);
  ensureDir(`${BACKUP_ROOT}/db`, 0o750);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = `${BACKUP_ROOT}/db/${name}-${ts}.sql.gz`;
  info(`Đang dump database '${name}'...`);
  dumpDatabase(name, outPath);
  ok(`Đã lưu backup tại ${outPath}`);
}

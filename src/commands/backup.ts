import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { runCmd, requireRoot, ensureDir, writeFile, commandExists } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { dumpAllDatabases, dumpDatabase, dbServiceRunning, dbExists, listDatabases } from "../lib/mysql";
import { loadState, BACKUP_ROOT, SYSTEMD_DIR } from "../lib/state";
import { writeManagedUnit } from "../lib/unitfile";
import { renderBackupService, renderBackupTimer } from "../templates/systemd";
import { timeToDailyOnCalendar } from "../lib/validate";

const NAPP_BIN_PATH = "/usr/local/bin/napp";
const BACKUP_TIMER_NAME = "napp-backup";
export const DEFAULT_RETENTION_DAYS = 14;

export type BackupTarget = "db" | "files" | "all";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface RetentionPolicy {
  keepDays: number; // xoá bản cũ hơn N ngày (0 = không xoá theo ngày)
  keepCount?: number; // (tuỳ chọn) giữ tối đa N bản gần nhất bất kể ngày
}

// Dọn backup cũ: xoá file cũ hơn keepDays, VÀ nếu đặt keepCount thì chỉ giữ
// keepCount bản gần nhất. Một file bị xoá nếu vi phạm BẤT KỲ điều kiện nào.
function pruneOldBackups(dir: string, policy: RetentionPolicy, log: (m: string) => void): void {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .map((f) => ({ f, path: `${dir}/${f}`, mtime: statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // mới nhất trước
  const remove = new Set<string>();
  if (policy.keepDays > 0) {
    const cutoff = Date.now() - policy.keepDays * 86_400_000;
    for (const f of files) if (f.mtime < cutoff) remove.add(f.path);
  }
  if (policy.keepCount && policy.keepCount > 0) {
    for (const f of files.slice(policy.keepCount)) remove.add(f.path);
  }
  for (const f of files) {
    if (remove.has(f.path)) {
      unlinkSync(f.path);
      log(`Đã xoá backup cũ: ${f.f}`);
    }
  }
}

export interface BackupRunOptions {
  target: BackupTarget;
  keepDays: number; // retention theo ngày
  keepCount?: number; // (tuỳ chọn) trần số bản gần nhất
  database?: string; // chỉ backup một database cụ thể (bỏ trống = tất cả)
  quiet?: boolean;
}

export function cmdBackupRun(opts: BackupRunOptions): void {
  requireRoot();
  const log = opts.quiet ? () => {} : info;
  const s = loadState();
  const ts = timestamp();
  const policy: RetentionPolicy = { keepDays: opts.keepDays, keepCount: opts.keepCount };

  if (opts.target === "db" || opts.target === "all") {
    if (!dbServiceRunning()) {
      warn("MariaDB/MySQL không chạy — bỏ qua backup database.");
    } else {
      ensureDir(`${BACKUP_ROOT}/db`, 0o750);
      if (opts.database) {
        // Backup MỘT database cụ thể (đã nén gzip trong dumpDatabase).
        if (!dbExists(opts.database)) die(`Database '${opts.database}' không tồn tại.`);
        const outPath = `${BACKUP_ROOT}/db/${opts.database}-${ts}.sql.gz`;
        log(`Đang backup database '${opts.database}'...`);
        dumpDatabase(opts.database, outPath);
        ok(`Database: ${outPath}`);
      } else {
        log("Đang backup toàn bộ database (mysqldump --all-databases, nén gzip)...");
        const outPath = `${BACKUP_ROOT}/db/all-databases-${ts}.sql.gz`;
        dumpAllDatabases(outPath);
        ok(`Database: ${outPath}`);
      }
      pruneOldBackups(`${BACKUP_ROOT}/db`, policy, log);
    }
  }

  if (opts.target === "files" || opts.target === "all") {
    ensureDir(`${BACKUP_ROOT}/files`, 0o750);
    const apps = Object.values(s.apps);
    if (apps.length === 0) {
      log("Không có app nào để backup mã nguồn.");
    }
    for (const app of apps) {
      const outPath = `${BACKUP_ROOT}/files/${app.domain}-${ts}.tar.gz`;
      log(`Đang nén mã nguồn '${app.domain}'...`);
      // Loại trừ node_modules/.git để giảm dung lượng — có thể khôi phục lại
      // bằng install command đã lưu trong registry (napp app deploy).
      runCmd("tar", [
        "--exclude=node_modules",
        "--exclude=.git",
        "-czf",
        outPath,
        "-C",
        "/var/www",
        app.domain,
      ]);
      ok(`Mã nguồn: ${outPath}`);
    }
    pruneOldBackups(`${BACKUP_ROOT}/files`, policy, log);
  }
}

function humanSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function cmdBackupList(): void {
  section("Danh sách backup");
  let total = 0;
  for (const sub of ["db", "files"]) {
    const dir = `${BACKUP_ROOT}/${sub}`;
    if (!existsSync(dir)) continue;
    console.log(`  ${sub}/  (${dir})`);
    const files = readdirSync(dir).sort();
    if (files.length === 0) console.log("    (trống)");
    for (const f of files) {
      const size = statSync(`${dir}/${f}`).size;
      total += size;
      console.log(`    - ${f.padEnd(48)} ${humanSize(size)}`);
    }
  }
  console.log(`\n  Tổng dung lượng backup: ${humanSize(total)}`);
}

export interface BackupScheduleOptions {
  time: string; // "HH:MM"
  keepDays: number; // retention theo ngày
  target: BackupTarget;
}

export function cmdBackupSchedule(opts: BackupScheduleOptions): void {
  requireRoot();
  const onCalendar = timeToDailyOnCalendar(opts.time);
  const scriptCmd = `${NAPP_BIN_PATH} backup run --target ${opts.target} --keep-days ${opts.keepDays} --quiet`;

  // ExecStart ở đây MANG THEO các tuỳ chọn của chính lệnh này (--target,
  // --keep-days) nên phải do napp làm chủ: giữ bản sửa tay cũ là làm ngược lại
  // thứ người dùng vừa gõ. Các directive khác (Nice, StandardOutput/Error,
  // User/Group...) họ sửa thì vẫn được giữ nguyên.
  writeManagedUnit(
    `${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.service`,
    renderBackupService(`/bin/bash -lc ${JSON.stringify(scriptCmd)}`),
    { authoritative: ["ExecStart"] }
  );
  writeFile(`${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.timer`, renderBackupTimer(onCalendar), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", `${BACKUP_TIMER_NAME}.timer`]);
  ok(`Đã lên lịch backup hàng ngày lúc ${opts.time} (giữ bản trong ${opts.keepDays} ngày, target=${opts.target}).`);
  info(`Kiểm tra lịch chạy: systemctl list-timers ${BACKUP_TIMER_NAME}.timer`);
}

export function cmdBackupUnschedule(): void {
  requireRoot();
  runCmd("systemctl", ["disable", "--now", `${BACKUP_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.service`, `${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"]);
  ok("Đã gỡ lịch backup tự động.");
}

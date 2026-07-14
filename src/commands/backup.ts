import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { runCmd, requireRoot, ensureDir, writeFile, commandExists } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { dumpAllDatabases, dumpDatabase, dbServiceRunning } from "../lib/mysql";
import { loadState, BACKUP_ROOT, SYSTEMD_DIR } from "../lib/state";
import { renderBackupService, renderBackupTimer } from "../templates/systemd";

const NAPP_BIN_PATH = "/usr/local/bin/napp";
const BACKUP_TIMER_NAME = "napp-backup";

export type BackupTarget = "db" | "files" | "all";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function pruneOldBackups(dir: string, keep: number): void {
  if (!existsSync(dir) || keep <= 0) return;
  const files = readdirSync(dir)
    .map((f) => ({ f, path: `${dir}/${f}`, mtime: statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const toRemove = files.slice(keep);
  for (const f of toRemove) {
    unlinkSync(f.path);
    info(`Đã xoá backup cũ: ${f.f}`);
  }
}

export interface BackupRunOptions {
  target: BackupTarget;
  keep: number;
  quiet?: boolean;
}

export function cmdBackupRun(opts: BackupRunOptions): void {
  requireRoot();
  const log = opts.quiet ? () => {} : info;
  const s = loadState();
  const ts = timestamp();

  if (opts.target === "db" || opts.target === "all") {
    if (!dbServiceRunning()) {
      warn("MariaDB/MySQL không chạy — bỏ qua backup database.");
    } else {
      ensureDir(`${BACKUP_ROOT}/db`, 0o750);
      log("Đang backup toàn bộ database (mysqldump --all-databases)...");
      const outPath = `${BACKUP_ROOT}/db/all-databases-${ts}.sql.gz`;
      dumpAllDatabases(outPath);
      ok(`Database: ${outPath}`);
      pruneOldBackups(`${BACKUP_ROOT}/db`, opts.keep);
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
    pruneOldBackups(`${BACKUP_ROOT}/files`, opts.keep * Math.max(1, apps.length));
  }
}

export function cmdBackupList(): void {
  section("Danh sách backup");
  for (const sub of ["db", "files"]) {
    const dir = `${BACKUP_ROOT}/${sub}`;
    if (!existsSync(dir)) continue;
    console.log(`  ${sub}/`);
    const files = readdirSync(dir).sort();
    for (const f of files) console.log(`    - ${f}`);
  }
}

export interface BackupScheduleOptions {
  time: string; // "HH:MM"
  keep: number;
  target: BackupTarget;
}

function timeToOnCalendar(time: string): string {
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) die(`Định dạng --time không hợp lệ: '${time}' (ví dụ hợp lệ: 03:30)`);
  const hh = parseInt(m[1]!, 10);
  const mm = parseInt(m[2]!, 10);
  if (hh > 23 || mm > 59) die(`Giờ/phút không hợp lệ: '${time}'`);
  return `*-*-* ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
}

export function cmdBackupSchedule(opts: BackupScheduleOptions): void {
  requireRoot();
  const onCalendar = timeToOnCalendar(opts.time);
  const scriptCmd = `${NAPP_BIN_PATH} backup run --target ${opts.target} --keep ${opts.keep} --quiet`;

  writeFile(`${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.service`, renderBackupService(`/bin/bash -lc ${JSON.stringify(scriptCmd)}`), 0o644);
  writeFile(`${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.timer`, renderBackupTimer(onCalendar), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", `${BACKUP_TIMER_NAME}.timer`]);
  ok(`Đã lên lịch backup hàng ngày lúc ${opts.time} (giữ ${opts.keep} bản gần nhất, target=${opts.target}).`);
  info(`Kiểm tra lịch chạy: systemctl list-timers ${BACKUP_TIMER_NAME}.timer`);
}

export function cmdBackupUnschedule(): void {
  requireRoot();
  runCmd("systemctl", ["disable", "--now", `${BACKUP_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.service`, `${SYSTEMD_DIR}/${BACKUP_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"]);
  ok("Đã gỡ lịch backup tự động.");
}

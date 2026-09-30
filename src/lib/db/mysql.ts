import { execCapture, runCmd, commandExists, ensureDir, writeFile, state as execState } from "../exec";
import { die, dryRunNotice, ok, info } from "../log";
import type { HardwareProfile } from "../hardware";
import type { CreatedDb, DbDriver } from "./types";
import { randomPassword, dpkgInstalled, anyUnitActive, processRunning, aptInstall, aptRemove, connectionUrl, preflightInstall } from "./common";

// Driver dùng CHUNG cho MariaDB và MySQL: cùng giao thức, cùng client
// (mysql/mariadb), cùng mysqldump, cùng /etc/mysql. Hai engine này LOẠI TRỪ
// nhau trên một máy (gói apt xung đột, cùng cổng 3306, cùng /var/lib/mysql) —
// lib/db/index.ts chặn việc chọn cả hai.

export const MYSQL_TUNING_PATH = "/etc/mysql/conf.d/napp-tuning.cnf";

type Variant = "mariadb" | "mysql";

// Database hệ thống — không liệt kê, không backup riêng.
const SYSTEM_DBS = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

export function mysqlBin(): string {
  if (commandExists("mysql")) return "mysql";
  if (commandExists("mariadb")) return "mariadb";
  die("Không tìm thấy mysql/mariadb client. Chạy 'napp db engine create mariadb' (hoặc mysql) để cài.");
}

function hasClient(): boolean {
  return commandExists("mysql") || commandExists("mariadb");
}

interface MysqlTuning {
  maxConnections: number;
  tmpTableMB: number;
  tableOpenCache: number;
}

function tierTuning(hw: HardwareProfile): MysqlTuning {
  return {
    maxConnections: hw.tier === "micro" ? 50 : hw.tier === "small" ? 100 : hw.tier === "medium" ? 150 : hw.tier === "large" ? 250 : 400,
    tmpTableMB: hw.tier === "micro" ? 16 : hw.tier === "small" ? 32 : 64,
    tableOpenCache: hw.tier === "micro" ? 200 : hw.tier === "small" ? 400 : 800,
  };
}

function mb(n: number): string {
  return `${Math.max(16, Math.round(n))}M`;
}

export function renderMysqlTuning(variant: Variant, hw: HardwareProfile, bufferPoolMB: number): string {
  const t = tierTuning(hw);
  // MySQL >= 8.0.30 thay innodb_log_file_size bằng innodb_redo_log_capacity
  // (tổng dung lượng redo log). MariaDB vẫn dùng innodb_log_file_size.
  const redoLine =
    variant === "mysql"
      ? `innodb_redo_log_capacity = ${mb(Math.max(128, bufferPoolMB * 0.5))}`
      : `innodb_log_file_size = ${mb(Math.max(64, bufferPoolMB * 0.25))}`;
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# Phần cứng phát hiện: ${hw.cpuCores} lõi CPU, ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM, tier=${hw.tier}
# Tỷ lệ RAM dành cho InnoDB buffer pool được tính TOÁN THẬN TRỌNG vì server
# còn chạy song song Node.js apps + Redis + nginx (và có thể cả engine DB khác).
[mysqld]
innodb_buffer_pool_size = ${mb(bufferPoolMB)}
innodb_buffer_pool_instances = ${Math.max(1, Math.min(8, Math.floor(bufferPoolMB / 1024) || 1))}
${redoLine}
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
innodb_io_capacity = ${hw.tier === "micro" ? 100 : hw.tier === "small" ? 200 : 400}

max_connections = ${t.maxConnections}
wait_timeout = 300
interactive_timeout = 300

tmp_table_size = ${mb(t.tmpTableMB)}
max_heap_table_size = ${mb(t.tmpTableMB)}

table_open_cache = ${t.tableOpenCache}
table_definition_cache = ${t.tableOpenCache}

thread_cache_size = ${Math.max(8, hw.cpuCores * 4)}

slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
`;
}

function makeMysqlDriver(variant: Variant): DbDriver {
  const label = variant === "mariadb" ? "MariaDB" : "MySQL";
  const packages = variant === "mariadb" ? ["mariadb-server", "mariadb-client"] : ["mysql-server", "mysql-client"];
  const purgeExtra = variant === "mariadb" ? ["mariadb-common"] : ["mysql-common"];
  const primaryUnit = variant === "mariadb" ? "mariadb" : "mysql";

  const driver: DbDriver = {
    engine: variant,
    label,
    port: 3306,
    extraPorts: variant === "mysql" ? [33060] : undefined,
    // Gói MariaDB của Ubuntu cài kèm alias mysql.service — kiểm cả hai.
    systemdUnits: variant === "mariadb" ? ["mariadb", "mysql"] : ["mysql"],
    dumpExt: ".sql.gz",
    maxNameLength: 64,

    isInstalled() {
      if (variant === "mariadb") return dpkgInstalled("mariadb-server") || commandExists("mariadbd");
      // MariaDB >= 10.5 cũng có /usr/sbin/mysqld (symlink tới mariadbd) — phải
      // loại trừ để không nhận nhầm MariaDB thành MySQL.
      return dpkgInstalled("mysql-server") || (commandExists("mysqld") && !commandExists("mariadbd"));
    },

    isRunning() {
      if (anyUnitActive(this.systemdUnits)) return true;
      // Fallback: một số môi trường (container, WSL) không có systemd làm PID 1
      // nhưng vẫn chạy MariaDB/MySQL thật qua init script khác — kiểm tra tiến
      // trình trực tiếp thay vì kết luận vội là "chưa chạy".
      return processRunning(variant === "mariadb" ? ["mariadbd", "mysqld"] : ["mysqld"]);
    },

    unit() {
      return primaryUnit;
    },

    install() {
      preflightInstall(label, 3306, "/var/lib/mysql", 1024);
      info(`Đang cài đặt ${label} server...`);
      aptInstall(packages);
      runCmd("systemctl", ["enable", "--now", primaryUnit]);
      ok(`Đã cài ${label} (khuyến nghị chạy 'sudo mysql_secure_installation' để rà soát cấu hình bảo mật)`);
    },

    uninstall({ purge }) {
      runCmd("systemctl", ["disable", "--now", primaryUnit], { silentFail: true });
      aptRemove(purge ? [...packages, `${variant}-server-core`, ...purgeExtra] : packages, purge);
      if (purge) runCmd("rm", ["-rf", "/var/lib/mysql", MYSQL_TUNING_PATH], { silentFail: true });
    },

    canConnectAsAdmin() {
      if (!hasClient()) return false;
      return execCapture(mysqlBin(), ["-e", "SELECT 1;"]).code === 0;
    },

    list() {
      if (!hasClient()) return [];
      const res = execCapture(mysqlBin(), ["-N", "-e", "SHOW DATABASES"]);
      if (res.code !== 0) return [];
      return res.stdout
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter((d) => d && !SYSTEM_DBS.has(d))
        .sort();
    },

    exists(name) {
      const res = execCapture(mysqlBin(), [
        "-N",
        "-e",
        `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${name.replace(/'/g, "")}'`,
      ]);
      return res.code === 0 && res.stdout.trim().length > 0;
    },

    // Tạo database + user CSDL riêng, quyền GRANT chỉ trên database đó (nguyên
    // tắc least privilege — không bao giờ dùng root cho kết nối của app).
    create(name, user): CreatedDb {
      if (!execState.dryRun) {
        // Ưu tiên kiểm tra bằng kết nối THẬT (nguồn sự thật đáng tin nhất). Chỉ
        // dùng isRunning() (dựa vào systemctl) làm gợi ý phụ khi không kết nối
        // được — một số môi trường (container, WSL, init khác systemd) vẫn chạy
        // DB thật dù systemctl báo sai.
        if (!this.canConnectAsAdmin()) {
          if (!this.isRunning()) {
            die(`${label} chưa chạy — không thể tạo database. Hãy 'systemctl start ${primaryUnit}' hoặc bỏ tuỳ chọn --db.`);
          }
          die(
            `Không kết nối được ${label} bằng quyền quản trị.\n` +
              "  Ubuntu mặc định cho phép root kết nối qua unix_socket (chạy napp bằng sudo).\n" +
              "  Nếu root CSDL có mật khẩu: tạo file /root/.my.cnf với [client] user+password."
          );
        }
        if (this.exists(name)) {
          die(`Database '${name}' đã tồn tại — không ghi đè. Hãy tự xử lý hoặc bỏ tuỳ chọn --db.`);
        }
      }

      const password = randomPassword();
      const sql = `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'localhost';
FLUSH PRIVILEGES;`;

      if (execState.dryRun) {
        dryRunNotice(`Sẽ tạo database ${label} '${name}' + user '${user}'@'localhost' (mật khẩu ngẫu nhiên)`);
        return { name, user, password: "<dry-run>" };
      }

      runCmd(mysqlBin(), [], { input: sql });
      return { name, user, password };
    },

    drop(name, user) {
      const parts = [`DROP DATABASE IF EXISTS \`${name}\`;`];
      if (user) parts.push(`DROP USER IF EXISTS '${user}'@'localhost';`);
      parts.push("FLUSH PRIVILEGES;");
      runCmd(mysqlBin(), [], { input: parts.join("\n") });
    },

    dump(name, outPath) {
      runCmd("bash", [
        "-lc",
        `set -o pipefail; mysqldump --single-transaction --quick --routines --triggers ${JSON.stringify(name)} | gzip > ${JSON.stringify(outPath)}`,
      ]);
    },

    dumpAll(outPath) {
      runCmd("bash", [
        "-lc",
        `set -o pipefail; mysqldump --all-databases --routines --triggers --events --single-transaction --quick | gzip > ${JSON.stringify(outPath)}`,
      ]);
    },

    envFor(db) {
      return {
        DB_CONNECTION: "mysql",
        DB_HOST: "127.0.0.1",
        DB_PORT: "3306",
        DB_DATABASE: db.name,
        DB_USERNAME: db.user,
        DB_PASSWORD: db.password,
        DATABASE_URL: connectionUrl("mysql", db, 3306),
      };
    },

    describeTuning(hw, budgetMB) {
      return [`InnoDB buffer pool ${Math.round(budgetMB)} MB · max_connections ${tierTuning(hw).maxConnections}`];
    },

    applyTuning(hw, budgetMB, opts) {
      ensureDir("/etc/mysql/conf.d", 0o755);
      writeFile(MYSQL_TUNING_PATH, renderMysqlTuning(variant, hw, budgetMB), 0o644);
      if (!opts.skipRestart && this.isRunning()) {
        runCmd("systemctl", ["restart", primaryUnit]);
        ok(`Đã áp tuning cho ${label} và khởi động lại.`);
      } else {
        ok(`Đã ghi ${MYSQL_TUNING_PATH}${opts.skipRestart ? " — chưa restart do --skip-restart." : " — service chưa chạy nên chưa restart."}`);
      }
    },
  };
  return driver;
}

export const mariadbDriver = makeMysqlDriver("mariadb");
export const mysqlDriver = makeMysqlDriver("mysql");

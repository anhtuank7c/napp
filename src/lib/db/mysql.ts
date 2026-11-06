import { execCapture, runCmd, commandExists, ensureDir, writeFile, shQuote, state as execState } from "../exec";
import { die, dryRunNotice, ok, info, warn } from "../log";
import type { HardwareProfile } from "../hardware";
import type { CreatedDb, DbDriver } from "./types";
import { randomPassword, anyUnitActive, processRunning, connectionUrl, preflightInstall } from "./common";
import { pkgInstalled, pkgInstall, pkgRemove, isRhel, mysqlConfDir } from "../platform";

// Driver dùng CHUNG cho MariaDB và MySQL: cùng giao thức, cùng client
// (mysql/mariadb), cùng mysqldump, cùng /etc/mysql (RHEL: /etc/my.cnf.d). Hai engine này LOẠI TRỪ
// nhau trên một máy (gói apt xung đột, cùng cổng 3306, cùng /var/lib/mysql) —
// lib/db/index.ts chặn việc chọn cả hai.

// Thư mục drop-in mà file cấu hình chính include sẵn: /etc/mysql/conf.d (Ubuntu)
// hoặc /etc/my.cnf.d (họ RHEL).
export const mysqlTuningPath = (): string => `${mysqlConfDir()}/napp-tuning.cnf`;
// Họ RHEL: MariaDB/MySQL mặc định nghe MỌI địa chỉ (bind-address bị comment,
// MySQL còn mở cả X Protocol 33060) — khác Ubuntu (127.0.0.1). napp ghim về
// localhost ngay lúc cài.
const RHEL_BIND_CONF = "/etc/my.cnf.d/napp-bind.cnf";

// Tên gói MySQL trên họ RHEL khác nhau theo bản: EL9 'mysql-server' (8.0),
// EL10 CHỈ có 'mysql8.4-server', Fedora có cả hai. Gói versioned không
// Provides 'mysql-server' -> 'rpm -q mysql-server' sẽ báo "chưa cài" nhầm.
const RHEL_MYSQL_SERVER_RE = /^(?:mysql(\d+\.\d+)?|community-mysql)-server$/;
const RHEL_MYSQL_CLIENT_RE = /^(?:mysql(\d+\.\d+)?|community-mysql)$/;

/** Gói MySQL (server + client) ĐANG CÀI — tên thật, để nhận diện và gỡ. */
function rhelMysqlInstalled(): string[] {
  const res = execCapture("rpm", ["-qa", "--qf", "%{NAME}\n"]);
  return res.stdout
    .split("\n")
    .map((x) => x.trim())
    .filter((n) => RHEL_MYSQL_SERVER_RE.test(n) || RHEL_MYSQL_CLIENT_RE.test(n));
}

/** Gói sẽ cài: nhánh versioned mới nhất kho có (8.4 LTS), không có thì mysql-server. */
function rhelMysqlPackages(): string[] {
  const res = execCapture("dnf", ["-q", "repoquery", "--available", "--qf", "%{name}\n", "mysql*-server"]);
  const versioned = [...new Set(res.stdout.split("\n").map((x) => x.trim()))]
    .map((n) => ({ n, v: n.match(/^mysql(\d+)\.(\d+)-server$/) }))
    .filter((x) => x.v)
    .sort((a, b) => Number(b.v![1]) - Number(a.v![1]) || Number(b.v![2]) - Number(a.v![2]));
  const server = versioned[0]?.n;
  return server ? [server, server.replace(/-server$/, "")] : ["mysql-server", "mysql"];
}

/** File log truy vấn chậm: thư mục log có sẵn của từng gói. */
function slowLogPath(variant: Variant): string {
  if (isRhel() && variant === "mariadb") return "/var/log/mariadb/slow.log";
  return "/var/log/mysql/slow.log";
}

/**
 * MySQL trên họ RHEL khởi tạo bằng --initialize-insecure: root@localhost
 * KHÔNG có mật khẩu — mọi user trên máy gõ 'mysql -uroot' là thành quản trị.
 * Chuyển root sang auth_socket (như Ubuntu): chỉ user root của hệ điều hành
 * đăng nhập được, qua unix socket.
 */
function secureRhelMysqlRoot(): void {
  if (execState.dryRun) return dryRunNotice("Sẽ chuyển root@localhost của MySQL sang auth_socket");
  const plugin = execCapture("mysql", ["-N", "-uroot", "-e", "SELECT plugin FROM mysql.user WHERE user='root' AND host='localhost'"]);
  if (plugin.code !== 0) {
    // Đã có mật khẩu/đã khoá từ trước (máy cài tay) — không đụng vào.
    if (execCapture("mysql", ["-e", "SELECT 1"]).code !== 0) warn("MySQL: root@localhost đã có mật khẩu — napp cần đăng nhập không mật khẩu bằng root (auth_socket) để quản lý database.");
    return;
  }
  if (plugin.stdout.trim() === "auth_socket") return;
  const res = execCapture("mysql", ["-uroot"], {
    input:
      "INSTALL PLUGIN auth_socket SONAME 'auth_socket.so';\n" +
      "ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket;\n",
  });
  // INSTALL PLUGIN báo lỗi nếu plugin đã nạp — chạy lại riêng ALTER USER.
  if (res.code !== 0) execCapture("mysql", ["-uroot", "-e", "ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket"]);
  if (execCapture("mysql", ["-N", "-e", "SELECT plugin FROM mysql.user WHERE user='root' AND host='localhost'"]).stdout.trim() === "auth_socket") {
    ok("MySQL: root@localhost chỉ đăng nhập được bằng user root của hệ thống (auth_socket), không còn mật khẩu rỗng.");
  } else {
    warn("MySQL: KHÔNG chuyển được root@localhost sang auth_socket — root đang KHÔNG có mật khẩu. Chạy 'sudo mysql_secure_installation'.");
  }
}

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
slow_query_log_file = ${slowLogPath(variant)}
long_query_time = 2
`;
}

function makeMysqlDriver(variant: Variant): DbDriver {
  const label = variant === "mariadb" ? "MariaDB" : "MySQL";
  const packages = (): string[] =>
    isRhel() ? (variant === "mariadb" ? ["mariadb-server", "mariadb"] : rhelMysqlPackages()) : variant === "mariadb" ? ["mariadb-server", "mariadb-client"] : ["mysql-server", "mysql-client"];
  const purgeExtra = variant === "mariadb" ? ["mariadb-common"] : ["mysql-common"];
  // MySQL trên họ RHEL chạy dưới tên mysqld.service.
  const primaryUnit = variant === "mariadb" ? "mariadb" : isRhel() ? "mysqld" : "mysql";

  const driver: DbDriver = {
    engine: variant,
    label,
    port: 3306,
    extraPorts: variant === "mysql" ? [33060] : undefined,
    // Gói MariaDB của Ubuntu cài kèm alias mysql.service — kiểm cả hai.
    systemdUnits: variant === "mariadb" ? ["mariadb", "mysql"] : ["mysql", "mysqld"],
    dumpExt: ".sql.gz",
    maxNameLength: 64,

    isInstalled() {
      if (variant === "mariadb") return pkgInstalled("mariadb-server") || commandExists("mariadbd");
      // MariaDB >= 10.5 cũng có /usr/sbin/mysqld (symlink tới mariadbd) — phải
      // loại trừ để không nhận nhầm MariaDB thành MySQL.
      if (commandExists("mariadbd")) return false;
      if (isRhel()) return rhelMysqlInstalled().some((n) => RHEL_MYSQL_SERVER_RE.test(n));
      return pkgInstalled("mysql-server") || commandExists("mysqld");
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
      // Chặn ở ĐÂY (mọi đường cài đều đi qua) chứ không chỉ ở tầng chọn engine:
      // 'check --fix' trên máy chưa từng chọn engine sẽ mặc định MariaDB, trong
      // khi máy có thể đang chạy MySQL cài tay. 'apt-get install -y mariadb-server'
      // khi đó GỠ MySQL để nhường chỗ và MariaDB tiếp quản /var/lib/mysql của nó.
      const other = variant === "mariadb" ? mysqlDriver : mariadbDriver;
      if (other.isInstalled()) {
        die(
          `Máy đang có ${other.label} — cài ${label} sẽ khiến apt GỠ ${other.label} (hai gói xung đột, dùng chung /var/lib/mysql).\n` +
            `  Muốn dùng ${other.label} đang có: sudo napp db engine set ${other.engine}\n` +
            `  Muốn chuyển hẳn sang ${label}: backup, 'sudo napp db engine delete ${other.engine}', rồi cài ${label} và import lại.`
        );
      }
      preflightInstall(label, 3306, "/var/lib/mysql", 1024);
      info(`Đang cài đặt ${label} server...`);
      pkgInstall(packages());
      if (isRhel()) {
        writeFile(
          RHEL_BIND_CONF,
          "# Managed by napp — chỉ nhận kết nối từ chính máy này.\n[mysqld]\nbind-address = 127.0.0.1\n" +
            (variant === "mysql" ? "mysqlx-bind-address = 127.0.0.1\n" : ""),
          0o644
        );
      }
      runCmd("systemctl", ["enable", "--now", primaryUnit]);
      if (isRhel() && variant === "mysql") secureRhelMysqlRoot();
      ok(`Đã cài ${label} (khuyến nghị chạy 'sudo mysql_secure_installation' để rà soát cấu hình bảo mật)`);
    },

    uninstall({ purge }) {
      runCmd("systemctl", ["disable", "--now", primaryUnit], { silentFail: true });
      if (isRhel()) {
        // Gỡ đúng tên gói thật (mysql8.4-server...), không phải tên "provides".
        const real = variant === "mysql" ? rhelMysqlInstalled() : packages();
        pkgRemove(real, purge);
      } else {
        pkgRemove(purge ? [...packages(), `${variant}-server-core`, ...purgeExtra] : packages(), purge);
      }
      if (purge) runCmd("rm", ["-rf", "/var/lib/mysql", mysqlTuningPath(), RHEL_BIND_CONF], { silentFail: true });
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

    userExists(_name, user) {
      const res = execCapture(mysqlBin(), [
        "-N",
        "-e",
        `SELECT 1 FROM mysql.user WHERE User='${user.replace(/'/g, "")}' AND Host='localhost'`,
      ]);
      return res.code === 0 && res.stdout.trim().length > 0;
    },

    // ALTER USER (MariaDB >= 10.2, MySQL >= 5.7). Kết nối ĐANG mở của app vẫn
    // sống; chỉ kết nối MỚI phải dùng mật khẩu mới.
    setPassword(_name, user, password) {
      if (execState.dryRun) {
        dryRunNotice(`Sẽ đặt mật khẩu mới cho user ${label} '${user}'@'localhost'`);
        return;
      }
      runCmd(mysqlBin(), [], { input: `ALTER USER '${user}'@'localhost' IDENTIFIED BY '${password}';\nFLUSH PRIVILEGES;` });
    },

    dump(name, outPath) {
      runCmd("bash", [
        "-lc",
        `set -o pipefail; mysqldump --single-transaction --quick --routines --triggers ${shQuote(name)} | gzip > ${shQuote(outPath)}`,
      ]);
    },

    dumpAll(outPath) {
      runCmd("bash", [
        "-lc",
        `set -o pipefail; mysqldump --all-databases --routines --triggers --events --single-transaction --quick | gzip > ${shQuote(outPath)}`,
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
      ensureDir(mysqlConfDir(), 0o755);
      writeFile(mysqlTuningPath(), renderMysqlTuning(variant, hw, budgetMB), 0o644);
      if (!opts.skipRestart && this.isRunning()) {
        runCmd("systemctl", ["restart", primaryUnit]);
        ok(`Đã áp tuning cho ${label} và khởi động lại.`);
      } else {
        ok(`Đã ghi ${mysqlTuningPath()}${opts.skipRestart ? " — chưa restart do --skip-restart." : " — service chưa chạy nên chưa restart."}`);
      }
    },
  };
  return driver;
}

export const mariadbDriver = makeMysqlDriver("mariadb");
export const mysqlDriver = makeMysqlDriver("mysql");

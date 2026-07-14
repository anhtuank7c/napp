import { randomBytes } from "node:crypto";
import { execCapture, runCmd, commandExists, state as execState } from "./exec";
import { die, dryRunNotice } from "./log";

export function mysqlBin(): string {
  if (commandExists("mysql")) return "mysql";
  if (commandExists("mariadb")) return "mariadb";
  die("Không tìm thấy mysql/mariadb client. Chạy 'napp check --fix' để cài MariaDB.");
}

export function dbServiceRunning(): boolean {
  const viaSystemd =
    execCapture("systemctl", ["is-active", "--quiet", "mariadb"]).code === 0 ||
    execCapture("systemctl", ["is-active", "--quiet", "mysql"]).code === 0;
  if (viaSystemd) return true;
  // Fallback: một số môi trường (container, WSL) không có systemd làm PID 1
  // nhưng vẫn chạy MariaDB thật qua init script khác — kiểm tra tiến trình
  // trực tiếp thay vì kết luận vội là "chưa chạy".
  const viaProcess = execCapture("bash", ["-lc", "pgrep -x mysqld >/dev/null 2>&1 || pgrep -x mariadbd >/dev/null 2>&1"]).code === 0;
  return viaProcess;
}

export function dbExists(name: string): boolean {
  const bin = mysqlBin();
  const res = execCapture(bin, [
    "-N",
    "-e",
    `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${name.replace(/'/g, "")}'`,
  ]);
  return res.code === 0 && res.stdout.trim().length > 0;
}

export function canConnectAsAdmin(): boolean {
  const bin = mysqlBin();
  return execCapture(bin, ["-e", "SELECT 1;"]).code === 0;
}

export function randomPassword(): string {
  return randomBytes(16).toString("hex");
}

export interface CreatedDb {
  name: string;
  user: string;
  password: string;
}

// Tạo database + user CSDL riêng, quyền GRANT chỉ trên database đó (nguyên
// tắc least privilege — không bao giờ dùng root cho kết nối của app).
export function createDatabase(name: string, user: string): CreatedDb {
  if (!execState.dryRun) {
    // Ưu tiên kiểm tra bằng kết nối THẬT (nguồn sự thật đáng tin nhất). Chỉ
    // dùng dbServiceRunning() (dựa vào systemctl) làm gợi ý phụ khi không
    // kết nối được — một số môi trường (container, WSL, init khác systemd)
    // vẫn chạy MariaDB thật dù systemctl báo sai.
    if (!canConnectAsAdmin()) {
      if (!dbServiceRunning()) {
        die("MariaDB/MySQL chưa chạy — không thể tạo database. Hãy 'systemctl start mariadb' (hoặc khởi động dịch vụ tương ứng) hoặc bỏ tuỳ chọn --db.");
      }
      die(
        "Không kết nối được MariaDB/MySQL bằng quyền quản trị.\n" +
          "  Ubuntu mặc định cho phép root kết nối qua unix_socket (chạy napp bằng sudo).\n" +
          "  Nếu root CSDL có mật khẩu: tạo file /root/.my.cnf với [client] user+password."
      );
    }
    if (dbExists(name)) {
      die(`Database '${name}' đã tồn tại — không ghi đè. Hãy tự xử lý hoặc bỏ tuỳ chọn --db.`);
    }
  }

  const password = randomPassword();
  const sql = `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '${user}'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'localhost';
FLUSH PRIVILEGES;`;

  if (execState.dryRun) {
    dryRunNotice(`Sẽ tạo database '${name}' + user '${user}'@'localhost' (mật khẩu ngẫu nhiên)`);
    return { name, user, password: "<dry-run>" };
  }

  const bin = mysqlBin();
  runCmd(bin, [], { input: sql });
  return { name, user, password };
}

export function dropDatabase(name: string, user?: string): void {
  const bin = mysqlBin();
  const parts = [`DROP DATABASE IF EXISTS \`${name}\`;`];
  if (user) parts.push(`DROP USER IF EXISTS '${user}'@'localhost';`);
  parts.push("FLUSH PRIVILEGES;");
  runCmd(bin, [], { input: parts.join("\n") });
}

export function dumpDatabase(name: string, outPath: string): void {
  runCmd("bash", [
    "-lc",
    `mysqldump --single-transaction --quick --routines --triggers ${JSON.stringify(name)} | gzip > ${JSON.stringify(outPath)}`,
  ]);
}

export function dumpAllDatabases(outPath: string): void {
  runCmd("bash", [
    "-lc",
    `mysqldump --all-databases --routines --triggers --events --single-transaction --quick | gzip > ${JSON.stringify(outPath)}`,
  ]);
}

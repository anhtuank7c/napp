import { existsSync, readdirSync } from "node:fs";
import { execCapture, runCmd, commandExists, ensureDir, writeFile, state as execState } from "../exec";
import { die, dryRunNotice, ok, info } from "../log";
import type { HardwareProfile } from "../hardware";
import type { CreatedDb, DbDriver } from "./types";
import { randomPassword, dpkgInstalled, processRunning, aptInstall, aptRemove, connectionUrl, preflightInstall } from "./common";

// PostgreSQL từ kho Ubuntu (24.04 -> 16, 22.04 -> 14). Cố ý KHÔNG thêm kho PGDG:
// bản vá bảo mật đi theo 'apt upgrade' như mọi gói hệ thống khác, và `napp
// doctor` đọc được trạng thái vá của nó.
//
// Quản trị qua peer auth: 'sudo -u postgres psql' — không cần lưu mật khẩu
// superuser ở đâu cả. App kết nối qua TCP 127.0.0.1 bằng mật khẩu
// (scram-sha-256, mặc định của pg_hba.conf trên Ubuntu).

const PG_ETC = "/etc/postgresql";
export const PG_TUNING_FILE = "napp-tuning.conf";

function psqlAdmin(): string[] {
  return ["-u", "postgres", "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1"];
}

// Câu lệnh CHỈ ĐỌC, trả về các dòng kết quả (không header, không căn lề).
function psqlQuery(sql: string, db = "postgres"): { ok: boolean; rows: string[]; stderr: string } {
  const res = execCapture("sudo", ["-u", "postgres", "psql", "-X", "-At", "-d", db, "-c", sql]);
  return {
    ok: res.code === 0,
    rows: res.stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    stderr: res.stderr.trim(),
  };
}

// Câu lệnh THAY ĐỔI — SQL đi qua stdin để mật khẩu không bao giờ nằm trong argv
// (ai cũng đọc được argv qua 'ps'). Lỗi kèm stderr của psql cho dễ lần.
function psqlExec(sql: string): void {
  const res = runCmd("sudo", psqlAdmin(), { input: sql, silentFail: true });
  if (res.code !== 0) die(`psql thất bại (mã ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
}

function q(ident: string): string {
  return `"${ident.replace(/"/g, "")}"`;
}

/** Thư mục cấu hình của cluster mới nhất, vd /etc/postgresql/16/main. */
function clusterConfDir(): string | undefined {
  if (!existsSync(PG_ETC)) return undefined;
  const versions = readdirSync(PG_ETC)
    .filter((v) => /^\d+$/.test(v) && existsSync(`${PG_ETC}/${v}/main`))
    .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  return versions[0] ? `${PG_ETC}/${versions[0]}/main` : undefined;
}

function maxConnectionsFor(hw: HardwareProfile): number {
  return hw.tier === "micro" ? 50 : hw.tier === "small" ? 80 : hw.tier === "medium" ? 120 : hw.tier === "large" ? 200 : 300;
}

interface PgTuning {
  sharedBuffersMB: number;
  effectiveCacheMB: number;
  workMemMB: number;
  maintenanceMB: number;
  maxConnections: number;
}

function pgTuning(hw: HardwareProfile, budgetMB: number): PgTuning {
  const maxConnections = maxConnectionsFor(hw);
  return {
    // Máy chủ DB chuyên dụng thường đặt shared_buffers ~25% RAM TOÀN MÁY; ở
    // đây budgetMB đã là phần RAM của riêng PostgreSQL nên lấy tỷ lệ cao hơn
    // trên phần đó — phần còn lại để page cache của OS lo (PostgreSQL dựa
    // nhiều vào page cache, khác InnoDB).
    sharedBuffersMB: Math.max(32, Math.round(budgetMB * 0.35)),
    effectiveCacheMB: Math.max(64, Math.round(budgetMB * 0.75)),
    // work_mem tính CHO MỖI thao tác sort/hash của MỖI kết nối — đặt rộng tay
    // là cách nhanh nhất để OOM. Chia phần 25% ngân sách cho số kết nối tối đa.
    workMemMB: Math.max(2, Math.min(64, Math.floor((budgetMB * 0.25) / maxConnections))),
    maintenanceMB: Math.max(32, Math.min(512, Math.round(budgetMB * 0.1))),
    maxConnections,
  };
}

export function renderPostgresTuning(hw: HardwareProfile, budgetMB: number): string {
  const t = pgTuning(hw, budgetMB);
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# Phần cứng phát hiện: ${hw.cpuCores} lõi CPU, ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM, tier=${hw.tier}
# Ngân sách RAM cho PostgreSQL: ${Math.round(budgetMB)} MB (server còn chạy Node.js apps + Redis + nginx).
shared_buffers = ${t.sharedBuffersMB}MB
effective_cache_size = ${t.effectiveCacheMB}MB
work_mem = ${t.workMemMB}MB
maintenance_work_mem = ${t.maintenanceMB}MB
max_connections = ${t.maxConnections}

# VPS gần như luôn chạy SSD/NVMe.
random_page_cost = 1.1
effective_io_concurrency = 200

# Tương đương slow_query_log của MariaDB: ghi câu truy vấn chạy quá 2 giây.
log_min_duration_statement = 2000
`;
}

export const postgresDriver: DbDriver = {
  engine: "postgresql",
  label: "PostgreSQL",
  port: 5432,
  systemdUnits: ["postgresql"],
  dumpExt: ".sql.gz",
  maxNameLength: 63,

  isInstalled() {
    if (dpkgInstalled("postgresql")) return true;
    // Cài thẳng gói có số phiên bản (postgresql-16) mà không qua gói meta.
    return existsSync("/usr/lib/postgresql") && readdirSync("/usr/lib/postgresql").some((v) => existsSync(`/usr/lib/postgresql/${v}/bin/postgres`));
  },

  // 'postgresql.service' trên Ubuntu chỉ là unit oneshot bọc các cluster — nó
  // báo "active" kể cả khi cluster đã chết. Tiến trình postgres mới là sự thật.
  isRunning() {
    return processRunning(["postgres"]);
  },

  unit() {
    return "postgresql";
  },

  install() {
    preflightInstall("PostgreSQL", 5432, "/var/lib/postgresql", 1024);
    info("Đang cài đặt PostgreSQL server...");
    aptInstall(["postgresql", "postgresql-client"]);
    runCmd("systemctl", ["enable", "--now", "postgresql"]);
    ok("Đã cài PostgreSQL (chỉ lắng nghe trên localhost — mặc định của Ubuntu).");
  },

  uninstall({ purge }) {
    runCmd("systemctl", ["disable", "--now", "postgresql"], { silentFail: true });
    const versioned = existsSync("/usr/lib/postgresql")
      ? readdirSync("/usr/lib/postgresql").flatMap((v) => [`postgresql-${v}`, `postgresql-client-${v}`])
      : [];
    aptRemove(purge ? ["postgresql", "postgresql-client", ...versioned, "postgresql-common", "postgresql-client-common"] : ["postgresql", ...versioned], purge);
    if (purge) runCmd("rm", ["-rf", "/var/lib/postgresql", PG_ETC], { silentFail: true });
  },

  canConnectAsAdmin() {
    if (!commandExists("psql")) return false;
    return psqlQuery("SELECT 1").ok;
  },

  list() {
    if (!commandExists("psql")) return [];
    const res = psqlQuery("SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1");
    return res.ok ? res.rows : [];
  },

  exists(name) {
    const res = psqlQuery(`SELECT 1 FROM pg_database WHERE datname = '${name.replace(/'/g, "")}'`);
    return res.ok && res.rows.length > 0;
  },

  // Least privilege giống MariaDB: role riêng, SỞ HỮU database của mình (tạo
  // bảng/migration được), và thu hồi CONNECT của PUBLIC để app khác trên cùng
  // máy không kết nối được vào database này.
  create(name, user): CreatedDb {
    if (!execState.dryRun) {
      if (!this.canConnectAsAdmin()) {
        if (!this.isRunning()) die("PostgreSQL chưa chạy — không thể tạo database. Hãy 'systemctl start postgresql' hoặc bỏ tuỳ chọn --db.");
        die("Không kết nối được PostgreSQL bằng quyền quản trị ('sudo -u postgres psql'). Kiểm tra pg_hba.conf còn dòng 'local all postgres peer'.");
      }
      if (this.exists(name)) die(`Database '${name}' đã tồn tại — không ghi đè. Hãy tự xử lý hoặc bỏ tuỳ chọn --db.`);
      if (psqlQuery(`SELECT 1 FROM pg_roles WHERE rolname = '${user.replace(/'/g, "")}'`).rows.length > 0) {
        die(`Role PostgreSQL '${user}' đã tồn tại — không ghi đè. Hãy tự xử lý hoặc dùng --user khác.`);
      }
    }

    const password = randomPassword();
    if (execState.dryRun) {
      dryRunNotice(`Sẽ tạo database PostgreSQL '${name}' + role '${user}' (mật khẩu ngẫu nhiên)`);
      return { name, user, password: "<dry-run>" };
    }
    psqlExec(
      `CREATE ROLE ${q(user)} LOGIN PASSWORD '${password}';\n` +
        `CREATE DATABASE ${q(name)} OWNER ${q(user)} ENCODING 'UTF8' TEMPLATE template0;\n` +
        `REVOKE ALL ON DATABASE ${q(name)} FROM PUBLIC;\n`
    );
    return { name, user, password };
  },

  drop(name, user) {
    // WITH (FORCE) (PostgreSQL >= 13): ngắt các kết nối còn mở thay vì lỗi
    // "database is being accessed by other users" khi app chưa dừng hẳn.
    let sql = `DROP DATABASE IF EXISTS ${q(name)} WITH (FORCE);\n`;
    if (user) sql += `DROP ROLE IF EXISTS ${q(user)};\n`;
    psqlExec(sql);
  },

  dump(name, outPath) {
    runCmd("bash", ["-lc", `set -o pipefail; cd / && sudo -u postgres pg_dump ${JSON.stringify(name)} | gzip > ${JSON.stringify(outPath)}`]);
  },

  dumpAll(outPath) {
    runCmd("bash", ["-lc", `set -o pipefail; cd / && sudo -u postgres pg_dumpall | gzip > ${JSON.stringify(outPath)}`]);
  },

  envFor(db) {
    return {
      DB_CONNECTION: "pgsql",
      DB_HOST: "127.0.0.1",
      DB_PORT: "5432",
      DB_DATABASE: db.name,
      DB_USERNAME: db.user,
      DB_PASSWORD: db.password,
      DATABASE_URL: connectionUrl("postgresql", db, 5432),
    };
  },

  describeTuning(hw, budgetMB) {
    const t = pgTuning(hw, budgetMB);
    return [`shared_buffers ${t.sharedBuffersMB} MB · effective_cache_size ${t.effectiveCacheMB} MB · work_mem ${t.workMemMB} MB · max_connections ${t.maxConnections}`];
  },

  applyTuning(hw, budgetMB, opts) {
    const dir = clusterConfDir();
    if (!dir) {
      info("Không tìm thấy cluster PostgreSQL trong /etc/postgresql — bỏ qua tuning.");
      return;
    }
    // postgresql.conf của Ubuntu đã có sẵn "include_dir = 'conf.d'".
    ensureDir(`${dir}/conf.d`, 0o755);
    const path = `${dir}/conf.d/${PG_TUNING_FILE}`;
    writeFile(path, renderPostgresTuning(hw, budgetMB), 0o644);
    // shared_buffers/max_connections chỉ đổi được khi RESTART (reload là không đủ).
    if (!opts.skipRestart && this.isRunning()) {
      runCmd("systemctl", ["restart", "postgresql"]);
      ok("Đã áp tuning cho PostgreSQL và khởi động lại.");
    } else {
      ok(`Đã ghi ${path}${opts.skipRestart ? " — chưa restart do --skip-restart." : " — service chưa chạy nên chưa restart."}`);
    }
  },
};

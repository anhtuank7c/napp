import { die } from "../log";
import { state as execState } from "../exec";
import { loadState, saveState } from "../state";
import { DB_ENGINES, DEFAULT_DB_ENGINE, type DbDriver, type DbEngine } from "./types";
import { mariadbDriver, mysqlDriver } from "./mysql";
import { postgresDriver } from "./postgres";
import { mongoDriver } from "./mongo";
import { publicListeners, describeListener, type PortListener } from "./common";

export { describeListener };

export { DB_ENGINES, DEFAULT_DB_ENGINE, type DbDriver, type DbEngine, type CreatedDb } from "./types";

const DRIVERS: Record<DbEngine, DbDriver> = {
  mariadb: mariadbDriver,
  mysql: mysqlDriver,
  postgresql: postgresDriver,
  mongodb: mongoDriver,
};

const ALIASES: Record<string, DbEngine> = {
  mariadb: "mariadb",
  maria: "mariadb",
  mysql: "mysql",
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
  pgsql: "postgresql",
  mongodb: "mongodb",
  mongo: "mongodb",
};

export function driverFor(engine: DbEngine): DbDriver {
  return DRIVERS[engine];
}

export function parseEngine(raw: string): DbEngine {
  const e = ALIASES[raw.trim().toLowerCase()];
  if (!e) die(`Database engine không hợp lệ: '${raw}'. Hỗ trợ: ${DB_ENGINES.join(", ")}.`);
  return e;
}

/** "mariadb,postgresql" -> [...]; "none" / "" -> []. */
export function parseEngineList(raw: string): DbEngine[] {
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "none" || s === "khong" || s === "không") return [];
  const out: DbEngine[] = [];
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const e = parseEngine(part);
    if (!out.includes(e)) out.push(e);
  }
  validateEngineSet(out);
  return out;
}

// MariaDB và MySQL không cùng tồn tại được trên một máy: gói apt xung đột, cùng
// cổng 3306, cùng /var/lib/mysql và /etc/mysql. Cài cái sau là apt gỡ cái trước
// — kèm nguy cơ mất dữ liệu. Chặn ngay ở tầng lựa chọn.
export function validateEngineSet(engines: DbEngine[]): void {
  if (engines.includes("mariadb") && engines.includes("mysql")) {
    die(
      "MariaDB và MySQL KHÔNG thể cài cùng lúc (gói apt xung đột, cùng cổng 3306 và cùng thư mục dữ liệu /var/lib/mysql).\n" +
        "  Chọn một trong hai. Muốn chuyển hẳn: backup, 'napp db engine remove <cũ>', rồi 'napp db engine add <mới>' và import lại."
    );
  }
}

/**
 * Tập engine người dùng MUỐN có (lưu trong state.json). Chưa từng chọn -> chỉ
 * MariaDB, đúng hành vi của mọi bản napp trước đây — nâng cấp napp không được
 * làm thay đổi gì trên server đang chạy.
 */
export function selectedEngines(): DbEngine[] {
  return loadState().dbEngines ?? [DEFAULT_DB_ENGINE];
}

/** true nếu người dùng đã chủ động chọn (kể cả chọn "không cài gì"). */
export function engineSelectionMade(): boolean {
  return loadState().dbEngines !== undefined;
}

export function setSelectedEngines(engines: DbEngine[]): void {
  validateEngineSet(engines);
  const s = loadState();
  s.dbEngines = [...engines];
  if (s.defaultDbEngine && !engines.includes(s.defaultDbEngine)) delete s.defaultDbEngine;
  saveState(s);
}

export function installedEngines(): DbEngine[] {
  return DB_ENGINES.filter((e) => DRIVERS[e].isInstalled());
}

/** Engine napp đang quản lý THẬT: đã chọn VÀ đã cài. Dùng cho tuning/backup/chia RAM. */
export function activeEngines(): DbEngine[] {
  const installed = new Set(installedEngines());
  return selectedEngines().filter((e) => installed.has(e));
}

/** Engine đã cài trên máy nhưng KHÔNG nằm trong lựa chọn — napp không đụng tới. */
export function unmanagedEngines(): DbEngine[] {
  const selected = new Set(selectedEngines());
  return installedEngines().filter((e) => !selected.has(e));
}

/**
 * Engine ĐÃ CÀI (kể cả không do napp quản lý) đang lắng nghe trên địa chỉ không
 * phải loopback. App trên cùng máy chỉ cần 127.0.0.1 — lộ ra ngoài chỉ còn
 * firewall đứng giữa database và Internet, và MongoDB cài tay thường còn tắt
 * xác thực. Hay gặp nhất: ai đó sửa bind-address/bindIp/listen_addresses để
 * "kết nối từ máy nhà cho tiện" rồi quên.
 */
export function exposedEngines(): { driver: DbDriver; listeners: PortListener[] }[] {
  const out: { driver: DbDriver; listeners: PortListener[] }[] = [];
  for (const e of installedEngines()) {
    const d = DRIVERS[e];
    const listeners = [d.port, ...(d.extraPorts ?? [])].flatMap(publicListeners);
    if (listeners.length > 0) out.push({ driver: d, listeners });
  }
  return out;
}

const BIND_SETTING: Record<DbEngine, string> = {
  mariadb: "bind-address trong /etc/mysql/mariadb.conf.d/50-server.cnf",
  mysql: "bind-address / mysqlx-bind-address trong /etc/mysql/mysql.conf.d/mysqld.cnf",
  postgresql: "listen_addresses trong /etc/postgresql/<phiên bản>/main/postgresql.conf",
  mongodb: "net.bindIp trong /etc/mongod.conf",
};

export function exposureMessage(x: { driver: DbDriver; listeners: PortListener[] }): string {
  return (
    `${x.driver.label} đang lắng nghe RA NGOÀI: ${x.listeners.map(describeListener).join("; ")}. ` +
    `App trên cùng máy chỉ cần 127.0.0.1 — lúc này chỉ còn firewall đứng giữa database và Internet. ` +
    `Đưa về 127.0.0.1 (${BIND_SETTING[x.driver.engine]}) rồi restart ${x.driver.unit()}; ` +
    `nếu CỐ Ý mở, chắc chắn UFW chỉ cho IP tin cậy vào cổng ${x.driver.port}.`
  );
}

/** Engine của một app/service. Bản ghi cũ (trước khi có lựa chọn engine) là MariaDB. */
export function unitEngine(rec: { dbEngine?: DbEngine }): DbEngine {
  return rec.dbEngine ?? DEFAULT_DB_ENGINE;
}

/**
 * Chọn engine cho một thao tác (app create --db, db create...):
 *  - chỉ định rõ -> dùng đúng engine đó (phải đã cài);
 *  - không chỉ định -> engine mặc định nếu đang hoạt động, hoặc engine DUY NHẤT
 *    đang hoạt động; nhiều engine mà không có mặc định -> bắt người dùng chọn,
 *    KHÔNG đoán (tạo nhầm engine là app kết nối sai mà không báo gì cho tới lúc chạy).
 */
export function resolveEngine(requested?: string | boolean): DbEngine {
  if (typeof requested === "string" && requested.length > 0) {
    const e = parseEngine(requested);
    if (!execState.dryRun && !DRIVERS[e].isInstalled()) {
      die(`${DRIVERS[e].label} chưa được cài. Cài bằng: sudo napp db engine add ${e}`);
    }
    return e;
  }
  const active = activeEngines();
  const def = loadState().defaultDbEngine;
  if (def && active.includes(def)) return def;
  if (active.length === 1) return active[0]!;
  if (active.length === 0) {
    if (execState.dryRun) return def ?? selectedEngines()[0] ?? DEFAULT_DB_ENGINE;
    die("Chưa có database engine nào được cài. Cài bằng: sudo napp db engine add mariadb (hoặc mysql, postgresql, mongodb).");
  }
  die(
    `Máy đang có nhiều database engine (${active.join(", ")}) — hãy chỉ định rõ, vd '--db ${active[0]}' / '--engine ${active[0]}',\n` +
      `  hoặc đặt engine mặc định: sudo napp db engine default ${active[0]}`
  );
}

import type { HardwareProfile } from "../hardware";

// Các database engine napp biết cài và quản lý. MariaDB là MẶC ĐỊNH (giữ nguyên
// hành vi của mọi bản napp trước khi có lựa chọn engine).
export const DB_ENGINES = ["mariadb", "mysql", "postgresql", "mongodb"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
export const DEFAULT_DB_ENGINE: DbEngine = "mariadb";

export interface CreatedDb {
  name: string;
  user: string;
  password: string;
}

export interface DbDriver {
  engine: DbEngine;
  label: string; // tên hiển thị: "MariaDB", "PostgreSQL"...
  port: number;
  // Cổng phụ engine cũng mở (MySQL X Protocol 33060) — chỉ dùng để soi lộ ra mạng.
  extraPorts?: number[];
  // Unit systemd có thể có của engine (thử lần lượt).
  systemdUnits: string[];
  // Đuôi file dump (không gồm timestamp): ".sql.gz", ".archive.gz".
  dumpExt: string;
  // Độ dài tối đa của tên database/user.
  maxNameLength: number;

  isInstalled(): boolean;
  isRunning(): boolean;
  /** Unit systemd thật sự đang có trên máy (để enable/restart), hoặc unit đầu tiên. */
  unit(): string;
  install(): void;
  /** Nhận quản lý một engine đã cài từ trước (không qua napp). Tuỳ chọn. */
  adopt?(): void;
  uninstall(opts: { purge: boolean }): void;

  canConnectAsAdmin(): boolean;
  /** Database do người dùng tạo (bỏ DB hệ thống). [] nếu không kết nối được. */
  list(): string[];
  exists(name: string): boolean;
  create(name: string, user: string): CreatedDb;
  drop(name: string, user?: string): void;
  dump(name: string, outPath: string): void;
  dumpAll(outPath: string): void;

  /** Biến môi trường ghi vào .env của app/service. */
  envFor(db: CreatedDb): Record<string, string>;

  /** Ghi cấu hình tối ưu theo ngân sách RAM dành cho engine này (MB). */
  applyTuning?(hw: HardwareProfile, budgetMB: number, opts: { skipRestart: boolean }): void;
  /** Mô tả ngắn các tham số tuning sẽ áp — cho `tune show`. */
  describeTuning?(hw: HardwareProfile, budgetMB: number): string[];
}

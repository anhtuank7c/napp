import { existsSync, readFileSync } from "node:fs";
import { writeFile, ensureDir, state as execState } from "./exec";
import { die } from "./log";

export const NAPP_ROOT = "/etc/napp";
export const STATE_PATH = `${NAPP_ROOT}/state.json`;
export const WWW_ROOT = "/var/www";
export const SOCK_DIR = "/run/napp"; // không dùng socket cho node (dùng TCP loopback), giữ lại cho tiện mở rộng
export const NGINX_AVAILABLE = "/etc/nginx/sites-available";
export const NGINX_ENABLED = "/etc/nginx/sites-enabled";
export const SYSTEMD_DIR = "/etc/systemd/system";
export const USER_PREFIX = "na_";
export const BACKUP_ROOT = "/var/backups/napp";
export const PORT_RANGE_START = 3000;
export const PORT_RANGE_END = 3999;
export const REDIS_DB_MAX = 16; // Redis mặc định có 16 database (0-15)

export interface AppRecord {
  domain: string;
  aliasDomains: string[]; // domain phụ trỏ vào cùng app (www, hoặc domain khác)
  user: string;
  webRoot: string;
  port: number;
  nodeRuntime: "node" | "bun";
  nodeVersion?: string; // ví dụ "22" — dùng khi máy có nhiều bản Node qua nvm
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  repoUrl?: string;
  branch: string;
  dbName?: string;
  dbUser?: string;
  redisDbIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NappState {
  version: 1;
  apps: Record<string, AppRecord>; // key = domain chính
  usedPorts: number[];
  usedRedisDb: number[];
}

function emptyState(): NappState {
  return { version: 1, apps: {}, usedPorts: [], usedRedisDb: [] };
}

let cache: NappState | null = null;

export function loadState(): NappState {
  if (cache) return cache;
  if (!existsSync(STATE_PATH)) {
    cache = emptyState();
    return cache;
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    cache = JSON.parse(raw) as NappState;
    cache.apps ??= {};
    cache.usedPorts ??= [];
    cache.usedRedisDb ??= [];
    return cache;
  } catch (e) {
    die(`Không đọc được ${STATE_PATH} (file registry bị hỏng?): ${(e as Error).message}`);
  }
}

export function saveState(s: NappState): void {
  cache = s;
  ensureDir(NAPP_ROOT, 0o750);
  // Ở chế độ dry-run, writeFile chỉ in ra chứ không ghi thật — an toàn.
  writeFile(STATE_PATH, JSON.stringify(s, null, 2) + "\n", 0o640);
  // Khi dry-run, không lưu cache thay đổi để tránh làm lệch trạng thái các
  // lệnh readonly chạy sau trong cùng tiến trình (không xảy ra thực tế vì
  // mỗi lần gọi napp là một process riêng, nhưng an toàn hơn).
  if (execState.dryRun) cache = null;
}

export function getApp(domain: string): AppRecord | undefined {
  return loadState().apps[domain];
}

export function requireApp(domain: string): AppRecord {
  const app = getApp(domain);
  if (!app) {
    die(
      `Không tìm thấy app cho domain '${domain}' trong registry (${STATE_PATH}).\n` +
        `  Chạy 'napp app list' để xem danh sách, hoặc 'napp app create ${domain} ...' để tạo mới.`
    );
  }
  return app;
}

export function upsertApp(app: AppRecord): void {
  const s = loadState();
  s.apps[app.domain] = app;
  if (!s.usedPorts.includes(app.port)) s.usedPorts.push(app.port);
  if (app.redisDbIndex !== undefined && !s.usedRedisDb.includes(app.redisDbIndex)) {
    s.usedRedisDb.push(app.redisDbIndex);
  }
  saveState(s);
}

export function removeApp(domain: string): AppRecord | undefined {
  const s = loadState();
  const app = s.apps[domain];
  if (!app) return undefined;
  delete s.apps[domain];
  s.usedPorts = s.usedPorts.filter((p) => p !== app.port);
  if (app.redisDbIndex !== undefined) {
    s.usedRedisDb = s.usedRedisDb.filter((d) => d !== app.redisDbIndex);
  }
  saveState(s);
  return app;
}

export function allocatePort(preferred?: number): number {
  const s = loadState();
  if (preferred !== undefined) {
    if (s.usedPorts.includes(preferred)) {
      die(`Cổng ${preferred} đã được app khác sử dụng. Hãy chọn cổng khác hoặc bỏ trống --port để tự động cấp phát.`);
    }
    return preferred;
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!s.usedPorts.includes(p)) return p;
  }
  die(`Đã hết cổng trống trong dải ${PORT_RANGE_START}-${PORT_RANGE_END}. Hãy chỉ định --port thủ công ngoài dải này.`);
}

export function allocateRedisDb(): number | undefined {
  const s = loadState();
  for (let i = 1; i < REDIS_DB_MAX; i++) {
    // DB 0 dành cho mục đích chung / để trống, bắt đầu cấp phát từ DB 1.
    if (!s.usedRedisDb.includes(i)) return i;
  }
  return undefined; // hết chỗ — caller sẽ cảnh báo dùng key-prefix thay vì DB riêng
}

export function slugFor(domain: string): string {
  const slug = domain
    .toLowerCase()
    .replace(/[.-]/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  return slug.slice(0, 24);
}

export function userFor(domain: string): string {
  return (USER_PREFIX + slugFor(domain)).slice(0, 32);
}

export function serviceNameFor(domain: string): string {
  return `napp-${slugFor(domain)}`;
}

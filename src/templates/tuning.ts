import type { HardwareProfile } from "../lib/hardware";

export const MARIADB_TUNING_PATH = "/etc/mysql/conf.d/napp-tuning.cnf";
export const REDIS_TUNING_PATH = "/etc/redis/conf.d/napp-tuning.conf";
export const SYSCTL_TUNING_PATH = "/etc/sysctl.d/99-napp-tuning.conf";

// Bảng tỷ lệ phân bổ RAM theo tier — vì server còn chạy Node apps + Redis +
// nginx + OS song song với MariaDB, KHÔNG dành 70-80% RAM cho DB như một máy
// chủ DB chuyên dụng. Tỷ lệ dưới đây thận trọng hơn, để lại chỗ cho các dịch
// vụ khác. Người dùng có thể ghi đè bằng --db-ram-percent khi chạy tune apply.
const DB_RAM_PERCENT: Record<HardwareProfile["tier"], number> = {
  micro: 25, // máy rất nhỏ: ưu tiên OS + 1-2 app node sống sót trước
  small: 35,
  medium: 40,
  large: 45,
  xlarge: 50,
};

const REDIS_RAM_PERCENT: Record<HardwareProfile["tier"], number> = {
  micro: 5,
  small: 8,
  medium: 10,
  large: 12,
  xlarge: 15,
};

// Heap V8 (--max-old-space-size) cho app node được CHIA SẺ theo số app đang
// chạy: lấy "ngân sách RAM cho app" = RAM tổng − phần dành cho MariaDB/Redis/OS,
// rồi chia đều cho số app, kẹp trong [sàn, trần theo tier]. Đây là GIỚI HẠN mỗi
// app (V8 gom rác trước khi chạm), KHÔNG phải RAM đặt trước. Nhờ chia theo số
// app, thêm/bớt app sẽ co giãn heap để tổng vừa với RAM (quan trọng trên máy nhỏ).
const NODE_OS_RESERVE_PERCENT: Record<HardwareProfile["tier"], number> = {
  micro: 25, // máy 1GB: chừa nhiều cho kernel/OS
  small: 20,
  medium: 18,
  large: 15,
  xlarge: 12,
};
const NODE_HEAP_CAP_MB: Record<HardwareProfile["tier"], number> = {
  micro: 384,
  small: 768,
  medium: 1280,
  large: 2048,
  xlarge: 3072,
};
const NODE_HEAP_FLOOR_MB = 128; // dưới mức này V8 gần như vô dụng cho app thực

function mb(n: number): string {
  return `${Math.max(16, Math.round(n))}M`;
}

// MB cho --max-old-space-size của MỖI app node khi trên máy có `appCount` app.
// appCount nên là TỔNG số app (node + bun) vì tất cả đều dùng chung RAM — chỉ
// app node được đặt cap tường minh, phần chia cho bun coi như chừa sẵn.
export function nodeMaxOldSpaceMB(hw: HardwareProfile, appCount = 1, dbRamPercentOverride?: number): number {
  const dbPercent = dbRamPercentOverride ?? DB_RAM_PERCENT[hw.tier];
  const budgetPercent = Math.max(15, 100 - dbPercent - REDIS_RAM_PERCENT[hw.tier] - NODE_OS_RESERVE_PERCENT[hw.tier]);
  const budgetMB = (hw.totalMemMB * budgetPercent) / 100;
  const perApp = Math.floor(budgetMB / Math.max(1, appCount));
  return Math.max(NODE_HEAP_FLOOR_MB, Math.min(NODE_HEAP_CAP_MB[hw.tier], perApp));
}

export interface TuningPlan {
  innodbBufferPoolMB: number;
  maxConnections: number;
  tmpTableMB: number;
  tableOpenCache: number;
  redisMaxMemoryMB: number;
  workerConnections: number;
  nodeMaxOldSpaceMB: number;
}

export function computeTuningPlan(hw: HardwareProfile, dbRamPercentOverride?: number, appCount = 1): TuningPlan {
  const dbPercent = dbRamPercentOverride ?? DB_RAM_PERCENT[hw.tier];
  const redisPercent = REDIS_RAM_PERCENT[hw.tier];
  const innodbBufferPoolMB = Math.round((hw.totalMemMB * dbPercent) / 100);
  const redisMaxMemoryMB = Math.round((hw.totalMemMB * redisPercent) / 100);

  const maxConnections = hw.tier === "micro" ? 50 : hw.tier === "small" ? 100 : hw.tier === "medium" ? 150 : hw.tier === "large" ? 250 : 400;
  const tmpTableMB = hw.tier === "micro" ? 16 : hw.tier === "small" ? 32 : 64;
  const tableOpenCache = hw.tier === "micro" ? 200 : hw.tier === "small" ? 400 : 800;
  const workerConnections = hw.tier === "micro" ? 1024 : hw.tier === "small" ? 2048 : 4096;

  return { innodbBufferPoolMB, maxConnections, tmpTableMB, tableOpenCache, redisMaxMemoryMB, workerConnections, nodeMaxOldSpaceMB: nodeMaxOldSpaceMB(hw, appCount, dbRamPercentOverride) };
}

export function renderMariadbTuning(hw: HardwareProfile, plan: TuningPlan): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# Phần cứng phát hiện: ${hw.cpuCores} lõi CPU, ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM, tier=${hw.tier}
# Tỷ lệ RAM dành cho InnoDB buffer pool được tính TOÁN THẬN TRỌNG vì server
# còn chạy song song Node.js apps + Redis + nginx.
[mysqld]
innodb_buffer_pool_size = ${mb(plan.innodbBufferPoolMB)}
innodb_buffer_pool_instances = ${Math.max(1, Math.min(8, Math.floor(plan.innodbBufferPoolMB / 1024) || 1))}
innodb_log_file_size = ${mb(Math.max(64, plan.innodbBufferPoolMB * 0.25))}
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT
innodb_io_capacity = ${hw.tier === "micro" ? 100 : hw.tier === "small" ? 200 : 400}

max_connections = ${plan.maxConnections}
wait_timeout = 300
interactive_timeout = 300

tmp_table_size = ${mb(plan.tmpTableMB)}
max_heap_table_size = ${mb(plan.tmpTableMB)}

table_open_cache = ${plan.tableOpenCache}
table_definition_cache = ${plan.tableOpenCache}

thread_cache_size = ${Math.max(8, hw.cpuCores * 4)}

slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
`;
}

export function renderRedisTuning(hw: HardwareProfile, plan: TuningPlan): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# Phần cứng phát hiện: ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM, tier=${hw.tier}
maxmemory ${plan.redisMaxMemoryMB}mb
# volatile-lru (KHÔNG phải allkeys-lru): chỉ loại bỏ các key CÓ đặt TTL khi đầy
# bộ nhớ. Vì napp dùng CHUNG một Redis cho nhiều app (mỗi app một DB index), nếu
# dùng allkeys-lru thì cache của app này đầy lên có thể trục xuất session/hàng
# đợi (queue) KHÔNG-TTL của app khác. Với volatile-lru, hãy đặt TTL cho các key
# cache; key không TTL (session bền, job) được giữ lại. Nếu Redis của bạn CHỈ
# làm cache thuần và không đặt TTL, đổi lại thành allkeys-lru.
maxmemory-policy volatile-lru

# Bền vững nhẹ (AOF everysec) — cân bằng giữa an toàn dữ liệu (session/cache
# của các app node) và hiệu năng. Nếu Redis chỉ dùng làm cache thuần tuý, có
# thể tắt appendonly để giảm I/O.
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Redis là đơn luồng cho phần xử lý lệnh — hạn chế client chậm chiếm giữ.
timeout 300
tcp-keepalive 300
`;
}

export function renderSysctlTuning(): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# ---- Network ----
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_keepalive_time = 600
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_tw_reuse = 1
net.ipv4.ip_local_port_range = 10000 65535
fs.file-max = 2097152
fs.nr_open = 2097152

# ---- Security ----
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# ---- Memory ----
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5
`;
}

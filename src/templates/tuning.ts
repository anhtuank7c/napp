import type { HardwareProfile } from "../lib/hardware";

export const REDIS_TUNING_PATH = "/etc/redis/conf.d/napp-tuning.conf";
export const SYSCTL_TUNING_PATH = "/etc/sysctl.d/99-napp-tuning.conf";

// Bảng tỷ lệ phân bổ RAM theo tier — vì server còn chạy Node apps + Redis +
// nginx + OS song song với database, KHÔNG dành 70-80% RAM cho DB như một máy
// chủ DB chuyên dụng. Tỷ lệ dưới đây thận trọng hơn, để lại chỗ cho các dịch
// vụ khác. Người dùng có thể ghi đè bằng --db-ram-percent khi chạy tune apply.
//
// Đây là phần RAM cho TẤT CẢ database engine cộng lại, KHÔNG phải cho mỗi
// engine: máy chạy MariaDB + PostgreSQL chia đôi con số này. Cộng dồn theo
// từng engine thì hai engine đã nuốt 70-100% RAM. Không có engine nào -> 0%,
// phần đó về tay heap của các app Node.
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

// Heap V8 (--max-old-space-size) cho app node được CHIA SẺ theo số đơn vị đang
// chạy: lấy "ngân sách RAM cho app" = RAM tổng − phần dành cho database/Redis/OS,
// rồi chia theo TRỌNG SỐ, kẹp trong [sàn, trần theo tier]. Đây là GIỚI HẠN mỗi
// đơn vị (V8 gom rác trước khi chạm), KHÔNG phải RAM đặt trước. Nhờ chia theo số
// đơn vị, thêm/bớt app sẽ co giãn heap để tổng vừa với RAM (quan trọng trên máy nhỏ).
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

// --- Ưu tiên tài nguyên: web app > background service -----------------------
//
// VÌ SAO CẦN CẢ HAI THỨ (heap và CPUWeight), và vì sao CPUWeight mới là thứ
// người dùng THẤY được:
//
// '--max-old-space-size' là một TRẦN, KHÔNG phải phần RAM đặt trước. Nó không
// giữ chỗ gì cả — nó nói cho V8 biết khi nào phải gom rác gắt và khi nào thì
// chết. Cho web app heap lớn hơn KHÔNG lấy đi gì của worker; nó chỉ cho web app
// lớn thêm trước khi thrash GC hoặc bị OOM. Đáng làm, nhưng nó không cứu được
// độ trễ request.
//
// Thứ THẬT SỰ phá trải nghiệm người dùng là TRANH CHẤP CPU. Một worker nén ảnh
// (sharp/ffmpeg) chiếm hết lõi sẽ làm mọi request chậm, và không con số heap nào
// đổi được điều đó dù chỉ một mili-giây.
//
// CPUWeight là công cụ đúng, và gần như miễn phí: nó là TỶ LỆ CHIA TƯƠNG ĐỐI,
// CHỈ có tác dụng KHI CÓ TRANH CHẤP. Worker rảnh -> web app vẫn dùng 100% CPU
// như thường. Worker chiếm hết lõi -> kernel chia theo trọng số thay vì cào
// bằng. Không đặt trước, không lãng phí gì.
//
// Mặc định của systemd là 100. 200 vs 50 cho tỷ lệ 4:1 khi có tranh chấp.
export const CPU_WEIGHT_WEB = 200;
export const CPU_WEIGHT_SERVICE = 50;

// IOWeight: cùng ý tưởng cho đĩa (worker ghi file lớn làm request đói I/O).
//
// TRUNG THỰC VỀ GIỚI HẠN: IOWeight CHỈ có tác dụng với I/O scheduler 'bfq'.
// Rất nhiều VPS NVMe chạy scheduler 'none' hoặc 'mq-deadline', ở đó directive
// này KHÔNG làm gì cả — nó không báo lỗi, chỉ đơn giản là vô hiệu. `napp tune`
// dò và nói thẳng ra điều đó thay vì in một con số không có tác dụng.
export const IO_WEIGHT_WEB = 200;
export const IO_WEIGHT_SERVICE = 50;

// Trọng số heap của background service so với web app. 0.5 = worker được nửa
// phần heap của một web app.
export const SERVICE_WEIGHT_DEFAULT = 0.5;

/**
 * MemoryHigh cho background service — giới hạn MỀM, KHÔNG phải MemoryMax.
 *
 * MemoryHigh vượt ngưỡng thì kernel THROTTLE và thu hồi bộ nhớ của cgroup đó
 * trước; nó KHÔNG giết tiến trình. Đó chính là hành vi mong muốn: khi cả máy
 * thiếu RAM, thu hồi từ worker trước khi động tới web app.
 *
 * CỐ Ý KHÔNG đặt MemoryMax cho service: MemoryMax là giới hạn CỨNG, vượt là
 * OOM-kill. Biến một worker chậm thành một worker CHẾT thì tệ hơn hẳn vấn đề
 * ban đầu.
 *
 * Hệ số 3x (sàn 256MB) là có chủ đích rộng rãi: heap V8 chỉ là MỘT PHẦN của
 * RSS (còn native, buffer, mã máy đã biên dịch). Đặt sát quá thì worker bị
 * throttle liên tục ngay cả khi máy đang rảnh — chậm mà không có lý do nào nhìn
 * thấy được, đúng loại hỏng khó chẩn đoán nhất.
 *
 * Áp cho MỌI service, kể cả bun: đây là cơ chế cgroup, không liên quan runtime
 * (khác heap V8 — thứ chỉ có nghĩa với node).
 */
export function serviceMemoryHighMB(serviceHeapMB: number): number {
  return Math.max(256, Math.round(serviceHeapMB * 3));
}

/** Số đơn vị chạy Node trên máy, tách theo loại. */
export interface UnitMix {
  webApps: number;
  services: number;
}

export interface NodeHeapPlan {
  webMB: number; // --max-old-space-size cho web app
  serviceMB: number; // ... cho background service
  serviceWeight: number;
  totalUnits: number;
}

export interface NodeHeapOptions {
  dbRamPercent?: number;
  /** Số database engine đang được napp quản lý (đã chọn + đã cài). Bỏ trống = 1. */
  dbEngines?: number;
  /** Trọng số heap của service so với web app (kẹp trong [0.1, 1]). */
  serviceWeight?: number;
}

/**
 * Chia ngân sách RAM cho các đơn vị node, ƯU TIÊN WEB APP.
 *
 * Trước 1.25.0 phép chia là cào bằng: budget / (số app + số service). Nghĩa là
 * một worker cron chạy mỗi giờ được đúng bằng heap của web app đang phục vụ
 * traffic — trong khi chỉ một trong hai cái đó ảnh hưởng tới người dùng thật.
 *
 * Nay mẫu số là TỔNG TRỌNG SỐ: `webApps + services * serviceWeight`. Tổng heap
 * cấp phát KHÔNG đổi (vẫn vừa đúng ngân sách), chỉ là phân bổ lại về phía
 * traffic. Ví dụ máy 4GB, 2 app + 2 service: trước là 327MB cho cả bốn; nay web
 * 436MB, service 218MB — tổng vẫn 1308MB.
 *
 * Không có web app nào (chỉ toàn service) thì mẫu số là `services * weight`, và
 * serviceMB quay về đúng `budget / services` — worker vẫn được trọn ngân sách
 * chứ không bị phạt vô cớ.
 */
export function nodeHeapPlan(hw: HardwareProfile, mix: UnitMix, opts: NodeHeapOptions = {}): NodeHeapPlan {
  const serviceWeight = Math.min(1, Math.max(0.1, opts.serviceWeight ?? SERVICE_WEIGHT_DEFAULT));
  const dbPercent = dbRamPercentFor(hw, opts.dbEngines ?? 1, opts.dbRamPercent);
  const budgetPercent = Math.max(15, 100 - dbPercent - REDIS_RAM_PERCENT[hw.tier] - NODE_OS_RESERVE_PERCENT[hw.tier]);
  const budgetMB = (hw.totalMemMB * budgetPercent) / 100;

  const denominator = mix.webApps + mix.services * serviceWeight;
  const perWeb = denominator > 0 ? budgetMB / denominator : budgetMB;
  const cap = NODE_HEAP_CAP_MB[hw.tier];
  const clamp = (v: number) => Math.max(NODE_HEAP_FLOOR_MB, Math.min(cap, Math.floor(v)));

  return {
    webMB: clamp(perWeb),
    serviceMB: clamp(perWeb * serviceWeight),
    serviceWeight,
    totalUnits: mix.webApps + mix.services,
  };
}

/** % RAM dành cho database (tổng mọi engine). 0 engine -> 0%. */
export function dbRamPercentFor(hw: HardwareProfile, engineCount: number, override?: number): number {
  if (engineCount <= 0) return 0;
  return override ?? DB_RAM_PERCENT[hw.tier];
}

export interface TuningPlan {
  dbRamPercent: number; // tổng % RAM cho mọi database engine
  dbEngines: number;
  dbBudgetPerEngineMB: number; // ngân sách RAM của MỖI engine
  redisMaxMemoryMB: number;
  workerConnections: number;
  heap: NodeHeapPlan;
}

export function computeTuningPlan(
  hw: HardwareProfile,
  dbRamPercentOverride?: number,
  mix: UnitMix = { webApps: 1, services: 0 },
  serviceWeight?: number,
  dbEngines = 1
): TuningPlan {
  const dbPercent = dbRamPercentFor(hw, dbEngines, dbRamPercentOverride);
  const redisPercent = REDIS_RAM_PERCENT[hw.tier];
  const dbBudgetPerEngineMB = dbEngines > 0 ? Math.round((hw.totalMemMB * dbPercent) / 100 / dbEngines) : 0;
  const redisMaxMemoryMB = Math.round((hw.totalMemMB * redisPercent) / 100);
  const workerConnections = hw.tier === "micro" ? 1024 : hw.tier === "small" ? 2048 : 4096;

  return {
    dbRamPercent: dbPercent,
    dbEngines,
    dbBudgetPerEngineMB,
    redisMaxMemoryMB,
    workerConnections,
    heap: nodeHeapPlan(hw, mix, { dbRamPercent: dbRamPercentOverride, serviceWeight, dbEngines }),
  };
}

export function renderRedisTuning(hw: HardwareProfile, plan: TuningPlan): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA bởi \`napp tune apply\`
# Phần cứng phát hiện: ${(hw.totalMemMB / 1024).toFixed(1)} GB RAM, tier=${hw.tier}
maxmemory ${plan.redisMaxMemoryMB}mb
# noeviction — BẮT BUỘC khi có app dùng BullMQ (hoặc hàng đợi Redis nói chung).
# BullMQ tự kiểm tra lúc kết nối và cảnh báo: "IMPORTANT! Eviction policy is
# volatile-lru. It should be noeviction".
#
# Lý do: dữ liệu hàng đợi KHÔNG phải cache — đó là job đang chờ/đang chạy, khoá,
# kết quả, thứ chỉ tồn tại một bản duy nhất. Với mọi chính sách lru/lfu/random,
# khi chạm maxmemory Redis sẽ TỰ TRỤC XUẤT key để nhường chỗ: job bốc hơi giữa
# chừng, KHÔNG bên nào báo lỗi (BullMQ chỉ thấy job "không còn tồn tại"). Kể cả
# volatile-lru cũng không an toàn: BullMQ có đặt TTL cho một số key (job đã
# xong, khoá, rate-limit), nên "chỉ trục xuất key có TTL" vẫn ăn đúng vào dữ
# liệu của hàng đợi. Với noeviction, Redis TỪ CHỐI lệnh ghi (báo OOM) thay vì âm
# thầm xoá — hỏng lộ liễu còn hơn mất việc trong im lặng.
#
# napp dùng CHUNG một Redis cho nhiều app (mỗi app một DB index), nên chỉ cần
# MỘT app dùng queue là cả instance phải noeviction — chính sách này áp cho toàn
# server, không tách theo DB index được.
#
# Đánh đổi: khi Redis đầy, lệnh ghi sẽ lỗi OOM chứ không tự dọn dẹp. Hãy ĐẶT TTL
# cho key cache của app (Redis vẫn xoá key hết hạn bình thường — noeviction chỉ
# tắt việc trục xuất key CHƯA hết hạn) và theo dõi 'napp redis info'
# (used_memory so với maxmemory).
maxmemory-policy noeviction

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

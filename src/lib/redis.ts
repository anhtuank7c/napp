import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execCapture, runCmd, writeFile, whichAll, isServiceActive, state as execState } from "./exec";
import { die, info, ok, warn } from "./log";
import { loadState, saveState, slugFor, findUnit, resolveRedisDb, SYSTEMD_DIR, NAPP_ROOT } from "./state";
import { computeTuningPlan } from "../templates/tuning";
import { detectHardware } from "./hardware";
import { portListeners } from "./db/common";

// --------------------------------------------------------------------------
// Redis RIÊNG cho từng app (OWASP A01).
//
// Trước đây mọi app dùng CHUNG một redis-server không mật khẩu ở 127.0.0.1:6379,
// mỗi app một "DB index" 0-15. Index chỉ là cách chia ngăn, KHÔNG phải ranh
// giới bảo mật: user Linux của BẤT KỲ app nào (hay bất kỳ user nào trên máy)
// cũng đọc/ghi được session, hàng đợi, cache của MỌI app khác — phá luôn lời
// hứa "mỗi app một user Linux riêng, cô lập với nhau" của napp.
//
// Nay mỗi "nhóm Redis" (một app, cộng các worker dùng chung qua
// --share-redis-with) có MỘT redis-server riêng:
//   - chạy bằng user hệ thống riêng nr_<id>, dữ liệu /var/lib/napp-redis/<id>;
//   - nghe 127.0.0.1:<cổng riêng 6400-6499> VỚI mật khẩu ngẫu nhiên 32 byte, và
//     một unix socket chỉ nhóm nr_<id> (các thành viên) mở được;
//   - mật khẩu CHỈ nằm trong /etc/napp/redis/<id>.conf (0640 root:nr_<id>) và
//     .env của các thành viên — không bao giờ trong state.json hay argv.
// --------------------------------------------------------------------------

export const REDIS_PORT_START = 6400;
export const REDIS_PORT_END = 6499;
export const REDIS_CONF_DIR = `${NAPP_ROOT}/redis`;

export interface RedisInstance {
  port: number;
  owner: string; // domain/name của đơn vị tạo ra nó
  members: string[]; // domain/name của mọi đơn vị đang dùng (kể cả owner)
  createdAt: string;
}

/** Định danh instance: slug + 6 ký tự băm — slug cắt ở 24 ký tự nên hai domain dài có thể trùng slug. */
export function instanceIdFor(owner: string): string {
  const hash = createHash("sha1").update(owner).digest("hex").slice(0, 6);
  return `${slugFor(owner).slice(0, 20)}_${hash}`;
}

export const redisUserFor = (id: string) => `nr_${id}`.slice(0, 32);
export const redisUnitFor = (id: string) => `napp-redis-${id}`;
export const redisConfPath = (id: string) => `${REDIS_CONF_DIR}/${id}.conf`;
export const redisDataDir = (id: string) => `/var/lib/napp-redis/${id}`;
export const redisSocketPath = (id: string) => `/run/napp-redis/${id}/redis.sock`;

export function instances(): Record<string, RedisInstance> {
  return loadState().redisInstances ?? {};
}

function serverBin(): string {
  const bin = whichAll("redis-server")[0];
  if (!bin) die("redis-server chưa được cài. Cài bằng: sudo napp check --fix");
  return bin;
}

export function renderRedisInstanceConf(id: string, port: number, password: string, maxmemoryMB: number): string {
  return `# Managed by napp — Redis RIÊNG của nhóm '${id}'. Chứa mật khẩu: 0640 root:${redisUserFor(id)}.
# Chỉ lắng nghe trên máy này; mọi kết nối (TCP lẫn socket) đều phải AUTH.
bind 127.0.0.1
port ${port}
protected-mode yes
requirepass ${password}
unixsocket ${redisSocketPath(id)}
unixsocketperm 660
dir ${redisDataDir(id)}
daemonize no
supervised no
logfile ""

maxmemory ${Math.max(16, Math.round(maxmemoryMB))}mb
# noeviction: hàng đợi (BullMQ...) KHÔNG phải cache — đầy thì báo lỗi ghi, không
# âm thầm xoá job. Xem thêm templates/tuning.ts.
maxmemory-policy noeviction

appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
timeout 300
tcp-keepalive 300
`;
}

export function renderRedisInstanceUnit(id: string, bin: string): string {
  const user = redisUserFor(id);
  return `# Managed by napp — Redis RIÊNG của nhóm '${id}'.
[Unit]
Description=napp Redis riêng (${id})
After=network.target

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=${bin} ${redisConfPath(id)}
Restart=always
RestartSec=3
RuntimeDirectory=napp-redis/${id}
RuntimeDirectoryMode=0750
StateDirectory=napp-redis/${id}
StateDirectoryMode=0750
LimitNOFILE=10032

# --- Hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
UMask=0007

[Install]
WantedBy=multi-user.target
`;
}

/** Cổng + mật khẩu của một instance, đọc từ file cấu hình (nguồn duy nhất của mật khẩu). */
export function readInstanceConf(id: string): { port: number; password: string } {
  const path = redisConfPath(id);
  if (!existsSync(path)) die(`Không thấy cấu hình Redis của '${id}' (${path}).`);
  const text = readFileSync(path, "utf8");
  const port = Number(/^port\s+(\d+)$/m.exec(text)?.[1]);
  const password = /^requirepass\s+(\S+)$/m.exec(text)?.[1] ?? "";
  if (!port || !password) die(`Cấu hình Redis của '${id}' thiếu port/requirepass (${path}).`);
  return { port, password };
}

/**
 * Chạy lệnh trên một instance bằng redis-cli qua unix socket. Mật khẩu đi qua
 * STDIN ('AUTH ...' là dòng đầu), không qua argv. Trả về các dòng kết quả sau AUTH.
 */
export function redisInstanceCmd(id: string, commandLines: string[]): { ok: boolean; lines: string[] } {
  const { password } = readInstanceConf(id);
  const res = execCapture("redis-cli", ["-s", redisSocketPath(id)], { input: [`AUTH ${password}`, ...commandLines, ""].join("\n") });
  const lines = res.stdout.split("\n").map((l) => l.trim());
  return { ok: res.code === 0 && lines[0] === "OK", lines: lines.slice(1).filter((l, i, a) => l !== "" || i < a.length - 1) };
}

function allocatePort(): number {
  const taken = new Set(Object.values(instances()).map((i) => i.port));
  for (let p = REDIS_PORT_START; p <= REDIS_PORT_END; p++) {
    if (taken.has(p)) continue;
    if (portListeners(p).length > 0) continue; // tiến trình khác đang dùng
    return p;
  }
  die(`Hết cổng cho Redis riêng (${REDIS_PORT_START}-${REDIS_PORT_END}).`);
}

/** Biến môi trường cho thành viên của một instance. Tương thích cách đọc cũ (HOST/PORT/DB/URL). */
export function redisEnvFor(id: string): Record<string, string> {
  if (execState.dryRun && !existsSync(redisConfPath(id))) {
    return { REDIS_HOST: "127.0.0.1", REDIS_PORT: "<cổng>", REDIS_PASSWORD: "<dry-run>", REDIS_DB: "0", REDIS_URL: "redis://:<dry-run>@127.0.0.1:<cổng>/0", REDIS_SOCKET: redisSocketPath(id) };
  }
  const { port, password } = readInstanceConf(id);
  return {
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: String(port),
    REDIS_PASSWORD: password,
    REDIS_DB: "0",
    REDIS_URL: `redis://:${password}@127.0.0.1:${port}/0`,
    REDIS_SOCKET: redisSocketPath(id),
  };
}

function waitReady(id: string, seconds: number): boolean {
  if (execState.dryRun) return true;
  for (let i = 0; i < seconds * 4; i++) {
    const r = redisInstanceCmd(id, ["PING"]);
    if (r.ok && r.lines[0] === "PONG") return true;
    execCapture("sleep", ["0.25"]);
  }
  return false;
}

/** Tạo instance cho một đơn vị (owner) và cho user Linux của nó vào nhóm. Trả về id. */
export function createRedisInstance(owner: string, ownerUser: string, maxmemoryMB: number): string {
  const bin = serverBin();
  const id = instanceIdFor(owner);
  const user = redisUserFor(id);
  const s = loadState();
  if (s.redisInstances?.[id]) die(`Redis riêng '${id}' đã tồn tại.`);
  const port = allocatePort();
  const password = randomBytes(32).toString("hex");

  info(`Đang tạo Redis riêng '${id}' (cổng ${port}, user ${user})...`);
  if (execCapture("id", [user]).code !== 0) {
    runCmd("useradd", ["--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", user]);
  }
  writeFile(redisConfPath(id), renderRedisInstanceConf(id, port, password, maxmemoryMB), 0o640, { group: user });
  writeFile(`${SYSTEMD_DIR}/${redisUnitFor(id)}.service`, renderRedisInstanceUnit(id, bin), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", redisUnitFor(id)]);
  runCmd("usermod", ["-aG", user, ownerUser]);
  if (!waitReady(id, 15)) {
    die(`Redis riêng '${id}' không phản hồi sau 15 giây — xem: journalctl -u ${redisUnitFor(id)} -n 50`);
  }
  s.redisInstances = { ...(s.redisInstances ?? {}), [id]: { port, owner, members: [owner], createdAt: new Date().toISOString() } };
  saveState(s);
  ok(`Redis riêng '${id}' sẵn sàng (127.0.0.1:${port}, có mật khẩu; socket ${redisSocketPath(id)}).`);
  return id;
}

/** Thêm một đơn vị (worker dùng chung hàng đợi) vào instance đã có. */
export function joinRedisInstance(id: string, member: string, memberUser: string): void {
  const s = loadState();
  const inst = s.redisInstances?.[id];
  if (!inst) die(`Không có Redis riêng '${id}'.`);
  if (!inst.members.includes(member)) inst.members.push(member);
  runCmd("usermod", ["-aG", redisUserFor(id), memberUser], { silentFail: true });
  saveState(s);
}

/**
 * Bỏ một đơn vị khỏi instance. Thành viên CUỐI rời đi -> dừng và gỡ instance;
 * dữ liệu giữ lại trừ khi purgeData.
 */
export function leaveRedisInstance(id: string, member: string, memberUser: string, opts: { purgeData: boolean }): void {
  const s = loadState();
  const inst = s.redisInstances?.[id];
  if (!inst) return;
  inst.members = inst.members.filter((m) => m !== member);
  // Chỉ gỡ khỏi nhóm nếu không còn đơn vị nào khác dùng CHÍNH user này (--run-as).
  runCmd("gpasswd", ["-d", memberUser, redisUserFor(id)], { silentFail: true });
  if (inst.members.length > 0) {
    saveState(s);
    info(`Redis riêng '${id}' vẫn còn dùng bởi: ${inst.members.join(", ")}.`);
    return;
  }
  const unit = redisUnitFor(id);
  runCmd("systemctl", ["disable", "--now", unit], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${unit}.service`, redisConfPath(id)], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"], { silentFail: true });
  runCmd("userdel", [redisUserFor(id)], { silentFail: true });
  if (opts.purgeData) runCmd("rm", ["-rf", redisDataDir(id)], { silentFail: true });
  delete s.redisInstances![id];
  saveState(s);
  ok(`Đã gỡ Redis riêng '${id}'${opts.purgeData ? " và dữ liệu" : ` (dữ liệu giữ ở ${redisDataDir(id)})`}.`);
}

export function instanceRunning(id: string): boolean {
  return isServiceActive(redisUnitFor(id));
}

/** RAM đang dùng (MB) của một instance, hoặc undefined nếu không hỏi được. */
export function instanceMemoryMB(id: string): number | undefined {
  const r = redisInstanceCmd(id, ["INFO memory"]);
  const m = r.lines.join("\n").match(/used_memory:(\d+)/);
  return m ? Number(m[1]) / 1048576 : undefined;
}

/** Đổi maxmemory: áp ngay bằng CONFIG SET (không restart) và ghi vào file cấu hình. */
export function setInstanceMaxmemory(id: string, mb: number): void {
  const value = `${Math.max(16, Math.round(mb))}mb`;
  const path = redisConfPath(id);
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8").replace(/^maxmemory\s+\S+$/m, `maxmemory ${value}`);
  writeFile(path, text, 0o640, { group: redisUserFor(id) });
  if (execState.dryRun || !instanceRunning(id)) return;
  const r = redisInstanceCmd(id, [`CONFIG SET maxmemory ${value}`]);
  if (!r.ok || r.lines[0] !== "OK") warn(`Redis riêng '${id}': không áp được maxmemory ngay (${r.lines.join(" ")}) — sẽ có hiệu lực ở lần khởi động lại.`);
}

/** Đặt một chuỗi vào dòng lệnh redis-cli: nháy kép + thoát ký tự (redis-cli hiểu \\xHH). */
export function quoteRedisArg(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

// --------------------------------------------------------------------------
// Cấp Redis cho một đơn vị mới (app hoặc service) — dùng chung cho cả hai.
// --------------------------------------------------------------------------

export interface RedisProvision {
  redisInstance?: string; // Redis riêng (mặc định)
  redisDbIndex?: number; // kiểu CŨ: DB index trên Redis dùng chung (không cô lập)
  createdInstance?: string; // vừa tạo mới -> rollback phải gỡ
  joinedInstance?: string; // vừa tham gia -> rollback phải rời
}

/** RAM cho một instance MỚI: phần của Redis trong ngân sách, chia đều cho các instance. */
function shareOfRedisBudget(): number {
  const total = computeTuningPlan(detectHardware()).redisMaxMemoryMB;
  const { ids, legacyInUse } = redisBudgetSplit(total);
  return total / (ids.length + 1 + (legacyInUse ? 1 : 0)); // +1: chính instance sắp tạo
}

export function provisionRedis(unitId: string, unitUser: string, opts: { redis: boolean; redisDb?: number; shareRedisWith?: string }): RedisProvision {
  if (opts.redisDb !== undefined) {
    const idx = resolveRedisDb(opts.redisDb);
    warn(
      `--redis-db ${opts.redisDb}: dùng Redis DÙNG CHUNG kiểu cũ (DB index #${idx}) — KHÔNG cô lập, mọi app trên máy đọc được dữ liệu này.\n` +
        `  Muốn cô lập: bỏ --redis-db, dùng --redis (hoặc --share-redis-with <app> để dùng chung với đúng một app).`
    );
    return { redisDbIndex: idx };
  }
  if (opts.shareRedisWith) {
    const target = findUnit(opts.shareRedisWith);
    if (!target) die(`--share-redis-with: không tìm thấy app/service '${opts.shareRedisWith}'. Xem: napp app list · napp service list`);
    if (target.redisInstance) {
      joinRedisInstance(target.redisInstance, unitId, unitUser);
      ok(`Dùng CHUNG Redis riêng '${target.redisInstance}' với '${opts.shareRedisWith}'.`);
      return { redisInstance: target.redisInstance, joinedInstance: target.redisInstance };
    }
    if (target.redisDbIndex !== undefined) {
      warn(
        `'${opts.shareRedisWith}' còn dùng Redis DÙNG CHUNG kiểu cũ (DB #${target.redisDbIndex}, không cô lập) — dùng chung theo đó.\n` +
          `  Nên chuyển cả nhóm sang Redis riêng: sudo napp redis migrate ${opts.shareRedisWith}`
      );
      return { redisDbIndex: target.redisDbIndex };
    }
    die(`--share-redis-with: '${opts.shareRedisWith}' không dùng Redis nên không có gì để dùng chung. Tạo nó với --redis.`);
  }
  if (!opts.redis) return {};
  const id = createRedisInstance(unitId, unitUser, shareOfRedisBudget());
  return { redisInstance: id, createdInstance: id };
}

/** Biến môi trường Redis của một đơn vị (riêng hoặc kiểu cũ). */
export function redisEnvForUnit(p: { redisInstance?: string; redisDbIndex?: number }): Record<string, string> {
  if (p.redisInstance) return redisEnvFor(p.redisInstance);
  if (p.redisDbIndex !== undefined) {
    return { REDIS_HOST: "127.0.0.1", REDIS_PORT: "6379", REDIS_DB: String(p.redisDbIndex), REDIS_URL: `redis://127.0.0.1:6379/${p.redisDbIndex}` };
  }
  return {};
}

/** Hoàn tác phần Redis khi tạo đơn vị thất bại giữa chừng. */
export function rollbackRedis(p: RedisProvision, unitId: string, unitUser: string): void {
  const id = p.createdInstance ?? p.joinedInstance;
  if (!id) return;
  try {
    leaveRedisInstance(id, unitId, unitUser, { purgeData: Boolean(p.createdInstance) });
  } catch {
    /* rollback không được chặn các bước hoàn tác còn lại */
  }
}

/** Mô tả ngắn cho màn hình (list/show). */
export function describeUnitRedis(p: { redisInstance?: string; redisDbIndex?: number }): string {
  if (p.redisInstance) {
    const inst = instances()[p.redisInstance];
    return `riêng '${p.redisInstance}'${inst ? ` (127.0.0.1:${inst.port}, có mật khẩu)` : ""}`;
  }
  if (p.redisDbIndex !== undefined) return `#${p.redisDbIndex} trên Redis DÙNG CHUNG — chưa cô lập (napp redis migrate)`;
  return "-";
}

/**
 * Chia phần RAM của Redis (theo tier phần cứng) cho các Redis riêng, cộng Redis
 * dùng chung NẾU còn đơn vị kiểu cũ dùng nó. Không ai dùng Redis chung nữa thì
 * nó không được tính (rỗng, không cần RAM).
 */
export function redisBudgetSplit(totalMB: number): { ids: string[]; legacyInUse: boolean; perMB: number } {
  const s = loadState();
  const ids = Object.keys(s.redisInstances ?? {});
  const legacyInUse = Object.values(s.apps).some((a) => a.redisDbIndex !== undefined) || Object.values(s.services).some((v) => v.redisDbIndex !== undefined);
  const parts = ids.length + (legacyInUse ? 1 : 0);
  return { ids, legacyInUse, perMB: parts > 0 ? totalMB / parts : totalMB };
}

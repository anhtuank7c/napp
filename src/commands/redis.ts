import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { ask } from "../lib/prompt";
import { info, ok, warn, die, section } from "../lib/log";
import { loadState, saveState, findUnit, upsertApp, upsertService, releaseRedisDbIfUnused, serviceNameFor, svcSystemdName, REDIS_DB_MAX } from "../lib/state";
import {
  instances,
  instanceRunning,
  instanceMemoryMB,
  redisInstanceCmd,
  redisUnitFor,
  redisSocketPath,
  readInstanceConf,
  createRedisInstance,
  joinRedisInstance,
  leaveRedisInstance,
  redisEnvFor,
  quoteRedisArg,
} from "../lib/redis";
import { mergeEnvFile } from "../lib/envfile";
import { unitWorkDir } from "../templates/systemd";
import { computeTuningPlan } from "../templates/tuning";
import { detectHardware } from "../lib/hardware";

function requireRedisCli(): void {
  if (!commandExists("redis-cli")) {
    die("redis-cli chưa được cài. Chạy 'napp check --fix' để cài Redis.");
  }
}

export function cmdRedisInfo(): void {
  requireRedisCli();
  const res = execCapture("redis-cli", ["INFO", "memory"]);
  console.log(res.stdout);
}

export function cmdRedisAllocations(): void {
  const s = loadState();
  section(`Cấp phát Redis DB (0-${REDIS_DB_MAX - 1})`);
  const apps = Object.values(s.apps).filter((a) => a.redisDbIndex !== undefined);
  if (apps.length === 0) {
    info("Chưa có app nào dùng Redis DB riêng.");
    return;
  }
  for (const a of apps) console.log(`  DB #${a.redisDbIndex} -> ${a.domain}`);
}

export async function cmdRedisFlush(dbIndex: number, opts: { yes: boolean }): Promise<void> {
  requireRoot();
  requireRedisCli();
  if (!Number.isInteger(dbIndex) || dbIndex < 0 || dbIndex >= REDIS_DB_MAX) {
    die(`DB index không hợp lệ: ${dbIndex} (0-${REDIS_DB_MAX - 1})`);
  }
  if (!opts.yes) {
    const ans = await ask(`Xoá TOÀN BỘ dữ liệu trong Redis DB #${dbIndex}? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }
  runCmd("redis-cli", ["-n", String(dbIndex), "FLUSHDB"]);
  ok(`Đã flush Redis DB #${dbIndex}.`);
}

// ==========================================================================
// Redis RIÊNG theo nhóm app (lib/redis.ts)
// ==========================================================================

/** Mọi Redis riêng + các đơn vị còn dùng Redis dùng chung kiểu cũ. */
export function cmdRedisList(): void {
  const s = loadState();
  const list = Object.entries(instances());
  section(`Redis riêng (${list.length})`);
  if (list.length === 0) info("Chưa có Redis riêng nào. Tạo kèm app: napp app create <domain> --redis");
  for (const [id, inst] of list) {
    const up = instanceRunning(id);
    const mem = up ? instanceMemoryMB(id) : undefined;
    console.log(
      `  ${up ? "●" : "○"} ${id.padEnd(30)} 127.0.0.1:${inst.port}  ${mem !== undefined ? `${mem.toFixed(1)} MB`.padEnd(9) : "-".padEnd(9)} dùng bởi: ${inst.members.join(", ")}`
    );
  }
  const legacy = [
    ...Object.values(s.apps).filter((a) => a.redisDbIndex !== undefined).map((a) => ({ id: a.domain, idx: a.redisDbIndex! })),
    ...Object.values(s.services).filter((v) => v.redisDbIndex !== undefined).map((v) => ({ id: v.name, idx: v.redisDbIndex! })),
  ];
  if (legacy.length) {
    section(`Còn dùng Redis DÙNG CHUNG kiểu cũ — CHƯA cô lập (${legacy.length})`);
    for (const l of legacy) console.log(`  DB #${String(l.idx).padEnd(3)} ${l.id}`);
    info("Chuyển từng nhóm sang Redis riêng (có dừng app vài giây): sudo napp redis migrate <app|service>");
  }
}

/** Chi tiết Redis của một đơn vị; không truyền đơn vị = Redis dùng chung (kiểu cũ). */
export function cmdRedisShow(unitId?: string): void {
  if (!unitId) return cmdRedisInfo();
  const unit = findUnit(unitId);
  if (!unit) die(`Không tìm thấy app/service '${unitId}'.`);
  section(`Redis của ${unit.kind} ${unitId}`);
  if (unit.redisInstance) {
    const id = unit.redisInstance;
    const inst = instances()[id];
    const up = instanceRunning(id);
    console.log(`  Loại        : Redis RIÊNG '${id}' (có mật khẩu, chỉ nhóm này dùng)`);
    console.log(`  Trạng thái  : ${up ? "đang chạy" : "ĐÃ DỪNG"} · systemd ${redisUnitFor(id)}`);
    console.log(`  Kết nối     : 127.0.0.1:${inst?.port ?? "?"} · socket ${redisSocketPath(id)}`);
    console.log(`  Dùng bởi    : ${inst?.members.join(", ") ?? "?"}`);
    if (up) {
      const r = redisInstanceCmd(id, ["INFO memory", "DBSIZE"]);
      const text = r.lines.join("\n");
      const used = text.match(/used_memory_human:(\S+)/)?.[1];
      const max = text.match(/maxmemory_human:(\S+)/)?.[1];
      const keys = r.lines[r.lines.length - 1];
      console.log(`  Bộ nhớ      : ${used ?? "?"} / tối đa ${max ?? "?"} · ${keys ?? "?"} key`);
    }
    console.log(`  Mật khẩu    : trong .env (REDIS_PASSWORD / REDIS_URL) của các đơn vị trên`);
  } else if (unit.redisDbIndex !== undefined) {
    const keys = execCapture("redis-cli", ["-n", String(unit.redisDbIndex), "DBSIZE"]).stdout.trim();
    console.log(`  Loại        : DB #${unit.redisDbIndex} trên Redis DÙNG CHUNG (127.0.0.1:6379, KHÔNG mật khẩu)`);
    console.log(`  Key         : ${keys || "?"}`);
    warn(`CHƯA cô lập: mọi user trên máy đọc/ghi được dữ liệu này. Chuyển sang Redis riêng: sudo napp redis migrate ${unitId}`);
  } else {
    info("Đơn vị này không dùng Redis.");
  }
}

interface Member {
  kind: "app" | "service";
  id: string;
  user: string;
  envPath: string;
  unit: string;
}

function legacyGroup(idx: number): Member[] {
  const s = loadState();
  return [
    ...Object.values(s.apps)
      .filter((a) => a.redisDbIndex === idx)
      .map((a) => ({ kind: "app" as const, id: a.domain, user: a.user, envPath: `${unitWorkDir(a.webRoot, a.appDir)}/.env`, unit: serviceNameFor(a.domain) })),
    ...Object.values(s.services)
      .filter((v) => v.redisDbIndex === idx)
      .map((v) => ({ kind: "service" as const, id: v.name, user: v.user, envPath: `${unitWorkDir(v.workDir, v.appDir)}/.env`, unit: svcSystemdName(v.name) })),
  ];
}

/**
 * Chuyển một nhóm (app + các worker dùng chung DB index) từ Redis dùng chung sang
 * Redis riêng, KHÔNG mất dữ liệu:
 *   dừng mọi đơn vị trong nhóm -> MIGRATE COPY toàn bộ key (giữ TTL) -> so số key
 *   -> khớp thì đổi .env + registry rồi chạy lại; lệch thì KHÔNG đổi gì, chạy lại
 *   như cũ. DB index cũ KHÔNG bị xoá — tự flush sau khi đã kiểm tra.
 */
export async function cmdRedisMigrate(unitId: string, opts: { yes: boolean }): Promise<void> {
  requireRoot();
  requireRedisCli();
  const unit = findUnit(unitId);
  if (!unit) die(`Không tìm thấy app/service '${unitId}'.`);
  if (unit.redisInstance) {
    ok(`'${unitId}' đã dùng Redis riêng '${unit.redisInstance}' — không cần chuyển.`);
    return;
  }
  if (unit.redisDbIndex === undefined) die(`'${unitId}' không dùng Redis.`);
  const idx = unit.redisDbIndex;
  const group = legacyGroup(idx);
  const sourceKeys = Number(execCapture("redis-cli", ["-n", String(idx), "DBSIZE"]).stdout.trim());
  if (!Number.isInteger(sourceKeys)) die("Không đọc được Redis dùng chung (redis-server có đang chạy ở 127.0.0.1:6379 không?).");

  section(`Chuyển Redis DB #${idx} sang Redis riêng`);
  console.log(`  Nhóm dùng chung DB này: ${group.map((m) => `${m.kind} ${m.id}`).join(", ")}`);
  console.log(`  Số key: ${sourceKeys}`);
  console.log(`  Các đơn vị trên sẽ DỪNG trong lúc chép (thường vài giây) rồi chạy lại trên Redis riêng.`);
  if (!opts.yes && !/^y(es)?$/i.test((await ask("Tiếp tục? [y/N] ")).trim())) {
    info("Đã huỷ. Không thay đổi gì.");
    return;
  }

  const owner = group.find((m) => m.id === unitId) ?? group[0]!;
  const id = createRedisInstance(owner.id, owner.user, computeTuningPlan(detectHardware()).redisMaxMemoryMB / (Object.keys(instances()).length + 2));
  for (const m of group) if (m.id !== owner.id) joinRedisInstance(id, m.id, m.user);

  const startAll = () => {
    for (const m of group) runCmd("systemctl", ["start", m.unit], { silentFail: true });
  };
  for (const m of group) runCmd("systemctl", ["stop", m.unit], { silentFail: true });

  try {
    // Chép theo lô 200 key. Lệnh đi qua STDIN của redis-cli (mật khẩu không vào argv);
    // key được đặt trong nháy kép + thoát ký tự, nên key có dấu cách/ký tự lạ vẫn đúng.
    const { port, password } = readInstanceConf(id);
    const keys = execCapture("redis-cli", ["-n", String(idx), "--scan", "--count", "1000"]).stdout.split("\n").filter((k) => k.length > 0);
    const lines: string[] = [];
    for (let i = 0; i < keys.length; i += 200) {
      const batch = keys.slice(i, i + 200).map(quoteRedisArg).join(" ");
      lines.push(`MIGRATE 127.0.0.1 ${port} "" 0 30000 COPY REPLACE AUTH ${quoteRedisArg(password)} KEYS ${batch}`);
    }
    if (lines.length) {
      const res = execCapture("redis-cli", ["-n", String(idx)], { input: lines.join("\n") + "\n" });
      const errs = res.stdout.split("\n").filter((l) => /ERR|error/i.test(l));
      if (res.code !== 0 || errs.length) die(`Chép key thất bại: ${(errs[0] ?? res.stderr).slice(0, 200)}`);
    }
    const destKeys = Number(redisInstanceCmd(id, ["DBSIZE"]).lines[0]);
    // Key có TTL có thể vừa hết hạn trong lúc chép: nguồn giảm theo, không phải lỗi.
    const sourceNow = Number(execCapture("redis-cli", ["-n", String(idx), "DBSIZE"]).stdout.trim());
    if (destKeys !== sourceNow) die(`Số key không khớp: DB #${idx} có ${sourceNow}, Redis riêng có ${destKeys}.`);
    ok(`Đã chép ${destKeys} key sang Redis riêng '${id}' (giữ nguyên TTL).`);
  } catch (e) {
    // Không đổi .env/registry: các đơn vị chạy lại TRÊN Redis dùng chung như cũ.
    startAll();
    for (const m of group) leaveRedisInstance(id, m.id, m.user, { purgeData: true });
    throw e;
  }

  const env = redisEnvFor(id);
  const s = loadState();
  for (const m of group) {
    mergeEnvFile(m.envPath, env, 0o600, m.user);
    if (m.kind === "app") {
      const a = s.apps[m.id]!;
      a.redisInstance = id;
      delete a.redisDbIndex;
      upsertApp(a);
    } else {
      const v = s.services[m.id]!;
      v.redisInstance = id;
      delete v.redisDbIndex;
      upsertService(v);
    }
  }
  const s2 = loadState();
  releaseRedisDbIfUnused(s2, idx);
  saveState(s2);
  startAll();
  ok(`Xong. ${group.map((m) => m.id).join(", ")} nay dùng Redis riêng '${id}' (có mật khẩu, .env đã cập nhật).`);
  info(`DB #${idx} trên Redis dùng chung CHƯA bị xoá. Kiểm tra app chạy đúng rồi dọn: sudo napp redis db flush ${idx}`);
}

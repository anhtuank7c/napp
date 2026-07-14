import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { info, ok, die, section } from "../lib/log";
import { loadState, REDIS_DB_MAX } from "../lib/state";

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
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Xoá TOÀN BỘ dữ liệu trong Redis DB #${dbIndex}? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }
  runCmd("redis-cli", ["-n", String(dbIndex), "FLUSHDB"]);
  ok(`Đã flush Redis DB #${dbIndex}.`);
}

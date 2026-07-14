import { execCapture, runCmd, requireRoot, ensureDir, writeFile, commandExists, isServiceActive } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { detectHardware, formatHardware } from "../lib/hardware";
import {
  computeTuningPlan,
  renderMariadbTuning,
  renderRedisTuning,
  renderSysctlTuning,
  MARIADB_TUNING_PATH,
  REDIS_TUNING_PATH,
  SYSCTL_TUNING_PATH,
} from "../templates/tuning";
import { renderNginxTuningConf, NGINX_TUNING_CONF } from "../templates/nginx";
import { renderAppSystemdService, execStartLine } from "../templates/systemd";
import { loadState, serviceNameFor, SYSTEMD_DIR } from "../lib/state";
import { readFileSync, existsSync } from "node:fs";

export function cmdTuneShow(): void {
  const hw = detectHardware();
  section("Phần cứng phát hiện được");
  console.log(formatHardware(hw));
  const plan = computeTuningPlan(hw);
  console.log();
  section("Kế hoạch tối ưu (chưa áp dụng — dùng `napp tune apply`)");
  console.log(`  InnoDB buffer pool : ${plan.innodbBufferPoolMB} MB`);
  console.log(`  MariaDB max_connections : ${plan.maxConnections}`);
  console.log(`  Redis maxmemory    : ${plan.redisMaxMemoryMB} MB (volatile-lru)`);
  console.log(`  nginx worker_connections : ${plan.workerConnections}`);
  console.log(`  Node heap mỗi app  : --max-old-space-size=${plan.nodeMaxOldSpaceMB} (NODE_OPTIONS, chỉ app runtime=node)`);
}

export interface TuneApplyOptions {
  dbRamPercent?: number;
  yes: boolean;
  skipRestart: boolean;
}

// Patch worker_processes/worker_connections trong khối `events {}` /
// `main` của nginx.conf — các tham số này KHÔNG thể đặt trong conf.d/*.conf
// (nginx chỉ cho phép ở ngữ cảnh gốc / events), nên cần sửa trực tiếp.
function patchNginxMainConf(workerConnections: number): void {
  const path = "/etc/nginx/nginx.conf";
  if (!existsSync(path)) {
    warn(`Không tìm thấy ${path} — bỏ qua patch worker_processes/worker_connections.`);
    return;
  }
  let content = readFileSync(path, "utf8");
  if (/^\s*worker_processes\s+/m.test(content)) {
    content = content.replace(/^\s*worker_processes\s+.*/m, "worker_processes auto; # managed by napp tune");
  } else {
    content = `worker_processes auto; # managed by napp tune\n${content}`;
  }
  if (/worker_connections\s+\d+/m.test(content)) {
    content = content.replace(/worker_connections\s+\d+;/m, `worker_connections ${workerConnections}; # managed by napp tune`);
  }
  writeFile(path, content, 0o644);
}

export async function cmdTuneApply(opts: TuneApplyOptions): Promise<void> {
  requireRoot();
  const hw = detectHardware();
  const plan = computeTuningPlan(hw, opts.dbRamPercent);

  section("Tối ưu theo phần cứng thực tế");
  console.log(formatHardware(hw));
  console.log();
  const appCount = Object.keys(loadState().apps).length;
  console.log(`  InnoDB buffer pool -> ${plan.innodbBufferPoolMB} MB`);
  console.log(`  Redis maxmemory    -> ${plan.redisMaxMemoryMB} MB (volatile-lru)`);
  console.log(`  nginx worker_connections -> ${plan.workerConnections}`);
  console.log(`  Node heap mỗi app  -> --max-old-space-size=${plan.nodeMaxOldSpaceMB} (áp cho ${appCount} app)`);
  if (hw.diskFreeGB > 0 && hw.diskFreeGB < 5) {
    warn(`Ổ đĩa trống chỉ còn ${hw.diskFreeGB} GB — chú ý dung lượng cho log/AOF Redis/backup.`);
  }
  console.log();

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("Áp dụng cấu hình trên và khởi động lại nginx/MariaDB/Redis + các app? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ. Không thay đổi gì.");
      return;
    }
  }

  // sysctl — luôn an toàn để áp, không phụ thuộc service nào đang chạy.
  writeFile(SYSCTL_TUNING_PATH, renderSysctlTuning(), 0o644);
  const sysctlRes = runCmd("sysctl", ["--system"], { silentFail: true });
  if (sysctlRes.code !== 0) {
    warn(
      "Một số tham số sysctl không áp được trên kernel/hạ tầng hiện tại (thường do thiếu module, ví dụ sch_fq " +
        "cho net.core.default_qdisc trên vài container/kernel tối giản) — các tham số còn lại vẫn đã được áp."
    );
  } else {
    ok("Đã áp sysctl tuning.");
  }

  // nginx
  if (commandExists("nginx")) {
    ensureDir("/etc/nginx/conf.d", 0o755);
    writeFile(NGINX_TUNING_CONF, renderNginxTuningConf(hw.cpuCores, hw.tier), 0o644);
    patchNginxMainConf(plan.workerConnections);
    const test = execCapture("nginx", ["-t"]);
    if (test.code !== 0) {
      warn(`Cấu hình nginx sau khi tune có lỗi cú pháp — ĐÃ GHI FILE nhưng KHÔNG reload:\n${test.stderr}`);
    } else if (!opts.skipRestart) {
      runCmd("systemctl", ["reload", "nginx"]);
      ok("Đã áp tuning cho nginx và reload.");
    }
  } else {
    warn("nginx chưa cài — bỏ qua.");
  }

  // MariaDB
  if (commandExists("mysqld") || commandExists("mariadbd")) {
    ensureDir("/etc/mysql/conf.d", 0o755);
    writeFile(MARIADB_TUNING_PATH, renderMariadbTuning(hw, plan), 0o644);
    if (!opts.skipRestart && isServiceActive("mariadb")) {
      runCmd("systemctl", ["restart", "mariadb"]);
      ok("Đã áp tuning cho MariaDB và khởi động lại.");
    } else if (!opts.skipRestart && isServiceActive("mysql")) {
      runCmd("systemctl", ["restart", "mysql"]);
      ok("Đã áp tuning cho MySQL và khởi động lại.");
    } else {
      ok(`Đã ghi ${MARIADB_TUNING_PATH} — service chưa chạy nên chưa restart.`);
    }
  } else {
    warn("MariaDB/MySQL chưa cài — bỏ qua.");
  }

  // Redis
  if (commandExists("redis-server")) {
    ensureDir("/etc/redis/conf.d", 0o755);
    writeFile(REDIS_TUNING_PATH, renderRedisTuning(hw, plan), 0o644);
    // Ubuntu package redis-server thường không tự include conf.d/*.conf —
    // đảm bảo có dòng include trong redis.conf chính.
    const mainConf = "/etc/redis/redis.conf";
    if (existsSync(mainConf)) {
      const content = readFileSync(mainConf, "utf8");
      if (!content.includes("conf.d/*.conf")) {
        writeFile(mainConf, content + "\ninclude /etc/redis/conf.d/*.conf\n", 0o640);
      }
    }
    if (!opts.skipRestart && isServiceActive("redis-server")) {
      runCmd("systemctl", ["restart", "redis-server"]);
      ok("Đã áp tuning cho Redis và khởi động lại.");
    } else {
      ok(`Đã ghi ${REDIS_TUNING_PATH} — service chưa chạy nên chưa restart.`);
    }
  } else {
    warn("Redis chưa cài — bỏ qua.");
  }

  // Các app: ghi lại unit systemd để (1) cập nhật NODE_OPTIONS heap V8 theo phần
  // cứng cho app node, (2) đồng bộ hardening mới (ProtectHome=tmpfs) sang cả app
  // cũ. Ghi file luôn (idempotent); chỉ restart khi không --skip-restart.
  const apps = Object.values(loadState().apps);
  if (apps.length > 0) {
    const nodeOpt = `--max-old-space-size=${plan.nodeMaxOldSpaceMB}`;
    for (const app of apps) {
      const nodeOptions = app.nodeRuntime === "node" ? nodeOpt : undefined;
      const unitPath = `${SYSTEMD_DIR}/${serviceNameFor(app.domain)}.service`;
      writeFile(unitPath, renderAppSystemdService(app, execStartLine(app.startCmd), { nodeOptions }), 0o644);
    }
    runCmd("systemctl", ["daemon-reload"]);
    if (!opts.skipRestart) {
      for (const app of apps) runCmd("systemctl", ["restart", serviceNameFor(app.domain)], { silentFail: true });
      ok(`Đã cập nhật unit + NODE_OPTIONS cho ${apps.length} app và khởi động lại (app node: heap ${plan.nodeMaxOldSpaceMB} MB).`);
    } else {
      ok(`Đã ghi lại unit cho ${apps.length} app (chưa restart do --skip-restart — chạy 'napp app restart <domain>' để áp).`);
    }
  }

  console.log();
  ok("Hoàn tất. Chạy lại lệnh này bất cứ khi nào nâng cấp phần cứng server.");
}

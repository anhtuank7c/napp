import { readFileSync, existsSync } from "node:fs";
import { execCapture, runCmd, commandExists, requireRoot, isServiceActive, writeFile, ensureDir } from "../lib/exec";
import { info, ok, warn, section, die } from "../lib/log";
import { REDIS_TUNING_PATH } from "../templates/tuning";
import { loadState, NGINX_AVAILABLE } from "../lib/state";
import { cmdNginxSync, stripInlineProxyBuffers } from "./nginx";

export interface CheckOptions {
  fix: boolean;
  yes: boolean;
}

interface Finding {
  name: string;
  ok: boolean;
  message: string;
  fix?: () => void;
}

function osRelease(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync("/etc/os-release")) return out;
  const raw = readFileSync("/etc/os-release", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  return out;
}

async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

function installNodejs(): void {
  info("Đang cài đặt Node.js 22.x LTS qua NodeSource...");
  runCmd("bash", ["-lc", "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"]);
  runCmd("apt-get", ["install", "-y", "nodejs"]);
  runCmd("bash", ["-lc", "corepack enable || true"]);
  ok("Đã cài Node.js");
}

function installNginx(): void {
  info("Đang cài đặt nginx...");
  runCmd("apt-get", ["update"]);
  runCmd("apt-get", ["install", "-y", "nginx"]);
  runCmd("systemctl", ["enable", "--now", "nginx"]);
  ok("Đã cài nginx");
}

function installCertbot(): void {
  info("Đang cài đặt certbot + plugin nginx...");
  runCmd("apt-get", ["install", "-y", "certbot", "python3-certbot-nginx"]);
  ok("Đã cài certbot");
}

function installMariadb(): void {
  info("Đang cài đặt MariaDB server...");
  runCmd("apt-get", ["install", "-y", "mariadb-server", "mariadb-client"]);
  runCmd("systemctl", ["enable", "--now", "mariadb"]);
  ok("Đã cài MariaDB (khuyến nghị chạy 'sudo mysql_secure_installation' để đặt mật khẩu root)");
}

function installRedis(): void {
  info("Đang cài đặt Redis server...");
  runCmd("apt-get", ["install", "-y", "redis-server"]);
  runCmd("systemctl", ["enable", "--now", "redis-server"]);
  ok("Đã cài Redis");
}

// Đọc maxmemory-policy ĐANG CHẠY (không phải trong file cấu hình) — trả về null
// nếu không hỏi được (redis-cli thiếu, cần auth, socket không mở...).
function redisEvictionPolicy(): string | null {
  if (!commandExists("redis-cli")) return null;
  const res = execCapture("redis-cli", ["CONFIG", "GET", "maxmemory-policy"]);
  if (res.code !== 0) return null;
  // Kết quả dạng 2 dòng: "maxmemory-policy" rồi tới giá trị. Chỉ chấp nhận một
  // trong các chính sách Redis biết — redis-cli có lúc in "(error) NOAUTH ..."
  // mà vẫn thoát 0, và đoán bừa ở đây là báo động giả cho người dùng.
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const value = lines[lines.length - 1] ?? "";
  const known = new Set(["noeviction", "volatile-lru", "allkeys-lru", "volatile-lfu", "allkeys-lfu", "volatile-random", "allkeys-random", "volatile-ttl"]);
  return known.has(value) ? value : null;
}

// Đặt noeviction cả ở RUNTIME lẫn trong file cấu hình của napp, để không mất
// sau khi restart Redis. Chỉ chạm file do napp sở hữu (conf.d), không sửa
// redis.conf gốc ngoài dòng `include`.
function fixRedisEvictionPolicy(): void {
  ensureDir("/etc/redis/conf.d", 0o755);
  const line = "maxmemory-policy noeviction";
  if (existsSync(REDIS_TUNING_PATH)) {
    const content = readFileSync(REDIS_TUNING_PATH, "utf8");
    const next = /^\s*maxmemory-policy\s+.*$/m.test(content)
      ? content.replace(/^\s*maxmemory-policy\s+.*$/m, line)
      : `${content.replace(/\n*$/, "\n")}${line}\n`;
    writeFile(REDIS_TUNING_PATH, next, 0o644);
  } else {
    writeFile(
      REDIS_TUNING_PATH,
      `# Managed by napp — đặt bởi \`napp check --fix\`\n` +
        `# BullMQ và mọi hàng đợi Redis YÊU CẦU noeviction: dữ liệu hàng đợi không\n` +
        `# phải cache, để Redis tự trục xuất là mất job mà không bên nào báo lỗi.\n` +
        `# Chạy 'napp tune apply' để sinh đầy đủ cấu hình Redis theo phần cứng.\n` +
        `${line}\n`,
      0o644
    );
  }
  // Ubuntu package redis-server thường không tự include conf.d/*.conf.
  const mainConf = "/etc/redis/redis.conf";
  if (existsSync(mainConf)) {
    const content = readFileSync(mainConf, "utf8");
    if (!content.includes("conf.d/*.conf")) {
      writeFile(mainConf, content + "\ninclude /etc/redis/conf.d/*.conf\n", 0o640);
    }
  }
  // CONFIG SET áp ngay, không phải restart Redis (restart là mất toàn bộ job
  // đang nằm trong bộ nhớ nếu chưa kịp ghi AOF).
  if (commandExists("redis-cli")) runCmd("redis-cli", ["CONFIG", "SET", "maxmemory-policy", "noeviction"], { silentFail: true });
  ok("Đã đặt maxmemory-policy=noeviction (áp ngay + ghi vào /etc/redis/conf.d/napp-tuning.conf).");
}

// Vhost tạo bằng bản trước 1.20.0 mang khối bộ đệm proxy NỘI TUYẾN trong
// 'location /'. Giá trị trong location luôn thắng giá trị mức http, nên site đó
// vẫn giữ proxy_buffer_size 16k và vẫn 502 ở route SvelteKit lồng sâu dù file
// dùng chung đã đúng. Không lệnh nào tự phát hiện giúp — nên check ở đây.
function vhostsWithInlineProxyBuffers(): string[] {
  const stale: string[] = [];
  for (const domain of Object.keys(loadState().apps)) {
    const conf = `${NGINX_AVAILABLE}/${domain}.conf`;
    if (!existsSync(conf)) continue;
    if (stripInlineProxyBuffers(readFileSync(conf, "utf8")).changed) stale.push(domain);
  }
  return stale;
}

function installFail2ban(): void {
  info("Đang cài đặt fail2ban...");
  runCmd("apt-get", ["install", "-y", "fail2ban"]);
  runCmd("systemctl", ["enable", "--now", "fail2ban"]);
  ok("Đã cài fail2ban (chạy 'napp fail2ban setup' để áp cấu hình jail)");
}

function installUfw(): void {
  info("Đang cài đặt UFW...");
  runCmd("apt-get", ["install", "-y", "ufw"]);
  ok("Đã cài UFW (chạy 'napp firewall sync' để bật và cấu hình)");
}

function installGit(): void {
  runCmd("apt-get", ["install", "-y", "git"]);
  ok("Đã cài git");
}

export async function cmdCheck(opts: CheckOptions): Promise<void> {
  if (opts.fix) requireRoot();
  section("Kiểm tra môi trường máy chủ");

  const findings: Finding[] = [];
  let hasApt = commandExists("apt-get");
  if (!hasApt) {
    warn("Không tìm thấy apt-get — công cụ này chỉ hỗ trợ Ubuntu/Debian. Việc tự cài đặt (--fix) sẽ bị bỏ qua.");
  }

  // OS
  const os = osRelease();
  if (os.ID === "ubuntu") {
    const major = parseInt((os.VERSION_ID ?? "0").split(".")[0] ?? "0", 10);
    if (major >= 20 && major <= 26) {
      ok(`Hệ điều hành: ${os.PRETTY_NAME ?? "Ubuntu " + os.VERSION_ID}`);
    } else {
      warn(`Ubuntu ${os.VERSION_ID} nằm ngoài phạm vi đã kiểm thử (20.04 - 26.04 LTS)`);
    }
  } else {
    warn(`Hệ điều hành chưa được kiểm thử: ${os.PRETTY_NAME ?? "không rõ"} (napp nhắm tới Ubuntu 20.04 - 26.04 LTS)`);
  }

  // Node.js
  if (commandExists("node")) {
    const v = execCapture("node", ["--version"]).stdout.trim();
    ok(`Node.js ${v}`);
  } else {
    findings.push({
      name: "Node.js",
      ok: false,
      message: "Node.js chưa được cài đặt (bắt buộc — dùng để chạy các app do napp quản lý).",
      fix: installNodejs,
    });
  }

  // sudo — bắt buộc vì app create/deploy chạy lệnh dưới user riêng của từng app qua `sudo -u`.
  if (commandExists("sudo")) {
    ok("sudo đã cài");
  } else {
    findings.push({
      name: "sudo",
      ok: false,
      message: "sudo chưa được cài (bắt buộc — napp dùng 'sudo -u <user>' để chạy lệnh cô lập theo từng app).",
      fix: () => runCmd("apt-get", ["install", "-y", "sudo"]),
    });
  }

  // git
  if (commandExists("git")) {
    ok(`git ${execCapture("git", ["--version"]).stdout.trim().replace(/^git version /, "")}`);
  } else {
    findings.push({ name: "git", ok: false, message: "git chưa được cài (cần cho deploy bằng --repo).", fix: installGit });
  }

  // nginx
  if (commandExists("nginx")) {
    const running = isServiceActive("nginx");
    if (running) ok("nginx đã cài và đang chạy");
    else {
      findings.push({
        name: "nginx",
        ok: false,
        message: "nginx đã cài nhưng chưa chạy.",
        fix: () => runCmd("systemctl", ["enable", "--now", "nginx"]),
      });
    }
    const stale = vhostsWithInlineProxyBuffers();
    if (stale.length > 0) {
      findings.push({
        name: "nginx-proxy-buffers",
        ok: false,
        message:
          `${stale.length} vhost còn khối bộ đệm proxy CŨ ngay trong 'location /' (${stale.join(", ")}). ` +
          `Giá trị trong location thắng giá trị mức http, nên các site này vẫn dùng proxy_buffer_size 16k ` +
          `và vẫn trả 502 ('upstream sent too big header') ở route SvelteKit lồng sâu. Sửa: napp nginx sync`,
        fix: () => cmdNginxSync(),
      });
    }
  } else {
    findings.push({ name: "nginx", ok: false, message: "nginx chưa được cài đặt (bắt buộc).", fix: installNginx });
  }

  // certbot
  if (commandExists("certbot")) {
    const plugins = execCapture("certbot", ["plugins"]).stdout;
    if (/nginx/i.test(plugins)) ok("certbot đã cài (có plugin nginx)");
    else {
      findings.push({
        name: "certbot-nginx-plugin",
        ok: false,
        message: "certbot đã cài nhưng THIẾU plugin nginx.",
        fix: () => runCmd("apt-get", ["install", "-y", "python3-certbot-nginx"]),
      });
    }
  } else {
    findings.push({ name: "certbot", ok: false, message: "certbot chưa được cài (cần cho SSL miễn phí).", fix: installCertbot });
  }

  // MariaDB
  if (isServiceActive("mariadb") || isServiceActive("mysql")) {
    ok("MariaDB/MySQL đang chạy");
  } else if (commandExists("mysqld") || commandExists("mariadbd")) {
    findings.push({
      name: "mariadb",
      ok: false,
      message: "MariaDB/MySQL đã cài nhưng chưa chạy.",
      fix: () => runCmd("systemctl", ["enable", "--now", "mariadb"]),
    });
  } else {
    findings.push({ name: "mariadb", ok: false, message: "MariaDB chưa cài (bắt buộc nếu dùng napp db).", fix: installMariadb });
  }

  // Redis
  if (isServiceActive("redis-server") || isServiceActive("redis")) {
    ok("Redis đang chạy");
    const policy = redisEvictionPolicy();
    if (policy === null) {
      warn("Không đọc được maxmemory-policy của Redis (redis-cli thiếu hoặc cần mật khẩu) — hãy tự kiểm tra: redis-cli CONFIG GET maxmemory-policy (phải là 'noeviction').");
    } else if (policy === "noeviction") {
      ok("Redis maxmemory-policy = noeviction (đúng cho BullMQ/hàng đợi)");
    } else {
      findings.push({
        name: "redis-policy",
        ok: false,
        message:
          `Redis maxmemory-policy = '${policy}', BullMQ (và mọi hàng đợi Redis) yêu cầu 'noeviction'. ` +
          `Job đang chờ không phải cache: khi chạm maxmemory, Redis sẽ tự trục xuất key và job biến mất giữa chừng mà KHÔNG bên nào báo lỗi.`,
        fix: fixRedisEvictionPolicy,
      });
    }
  } else if (commandExists("redis-server")) {
    findings.push({
      name: "redis",
      ok: false,
      message: "Redis đã cài nhưng chưa chạy.",
      fix: () => runCmd("systemctl", ["enable", "--now", "redis-server"]),
    });
  } else {
    findings.push({ name: "redis", ok: false, message: "Redis chưa cài (tuỳ chọn — bỏ qua nếu app không dùng cache/queue Redis).", fix: installRedis });
  }

  // fail2ban
  if (isServiceActive("fail2ban")) ok("fail2ban đang chạy");
  else if (commandExists("fail2ban-client")) {
    findings.push({
      name: "fail2ban",
      ok: false,
      message: "fail2ban đã cài nhưng chưa chạy.",
      fix: () => runCmd("systemctl", ["enable", "--now", "fail2ban"]),
    });
  } else {
    findings.push({ name: "fail2ban", ok: false, message: "fail2ban chưa cài (khuyến nghị cài để chống brute-force).", fix: installFail2ban });
  }

  // UFW
  if (commandExists("ufw")) {
    const status = execCapture("ufw", ["status"]).stdout;
    if (/Status: active/i.test(status)) ok("UFW đã cài và đang active");
    else warn("UFW đã cài nhưng CHƯA active — chạy 'napp firewall sync' để bật (script sẽ tự thêm rule SSH trước khi bật để tránh khoá bạn ra ngoài).");
  } else {
    findings.push({ name: "ufw", ok: false, message: "UFW chưa cài (khuyến nghị để giới hạn cổng mở).", fix: installUfw });
  }

  if (findings.length === 0) {
    ok("Môi trường đã sẵn sàng đầy đủ.");
    info("Kiểm tra thêm về BẢO MẬT (bản vá đang chờ, rủi ro dependencies): sudo napp doctor");
    return;
  }

  console.log();
  warn(`Phát hiện ${findings.length} mục cần chú ý:`);
  for (const f of findings) console.log(`  - [${f.name}] ${f.message}`);

  if (!opts.fix) {
    console.log();
    info("Chạy lại với '--fix' (cần sudo) để napp tự cài/khởi động các thành phần còn thiếu.");
    return;
  }

  if (!hasApt) {
    warn("Bỏ qua --fix vì không có apt-get trên hệ thống này.");
    return;
  }

  console.log();
  const proceed = await confirm(`Tiến hành cài đặt/khởi động ${findings.length} thành phần còn thiếu ở trên?`, opts.yes);
  if (!proceed) {
    info("Đã huỷ. Không thay đổi gì.");
    return;
  }

  for (const f of findings) {
    if (f.fix) f.fix();
  }
  ok("Hoàn tất --fix. Chạy lại 'napp check' để xác nhận.");
}

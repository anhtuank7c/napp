import { readFileSync, existsSync } from "node:fs";
import { execCapture, runCmd, commandExists, requireRoot, isServiceActive } from "../lib/exec";
import { info, ok, warn, section, die } from "../lib/log";

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

import { readFileSync, existsSync } from "node:fs";
import { execCapture, runCmd, commandExists, requireRoot, isServiceActive, writeFile, ensureDir } from "../lib/exec";
import { info, ok, warn, section, die } from "../lib/log";
import { REDIS_TUNING_PATH } from "../templates/tuning";
import { loadState, NGINX_AVAILABLE, type AppRecord } from "../lib/state";
import { cmdNginxSync, stripInlineProxyBuffers } from "./nginx";
import { cmdAppSet } from "./app";
import { detectStaticLayout, detectUploadDir, staticSetCommand, type StaticSuggestion } from "../lib/framework";
import { appServePaths, grantNginxGroupAccess, nginxWorkerUser, pathReadableBy } from "../lib/staticaccess";
import { unitWorkDir } from "../templates/systemd";

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

// --- asset tĩnh: app nào ĐANG đẩy toàn bộ asset qua Node ---------------------
//
// Đây là loại hỏng KHÔNG có triệu chứng nào để lần ra: không log, không lỗi,
// không mã trạng thái lạ. App chỉ đơn giản là chậm — mỗi trang kéo hàng trăm
// chunk .js/.css, tất cả xếp hàng trên event loop đơn luồng và tranh chấp với
// chính việc render. Người dùng mô tả nó là "vào dashboard thấy giựt" và đi đo
// CPU/RAM, nơi mọi thứ trông hoàn toàn bình thường.
//
// Vì không ai tự đi tìm một cấu hình mình không biết là có, chỗ để nói ra là
// đây — lệnh mà người dùng vốn đã chạy sau mỗi lần nâng cấp.
interface StaticCandidate {
  app: AppRecord;
  suggestion: StaticSuggestion;
}

function staticCandidates(): StaticCandidate[] {
  const out: StaticCandidate[] = [];
  for (const app of Object.values(loadState().apps)) {
    // Đã cấu hình rồi thì không đụng vào: người dùng có thể đã cố ý chọn tiền
    // tố khác với bảng luật (và họ hiểu app của mình hơn bảng luật).
    if (app.staticRoot || (app.staticAliases?.length ?? 0) > 0) continue;
    const suggestion = detectStaticLayout(unitWorkDir(app.webRoot, app.appDir));
    if (suggestion) out.push({ app, suggestion });
  }
  return out;
}

// Cấu hình tĩnh ĐÚNG nhưng nginx không đọc nổi thư mục -> 403, không phải file.
// Trả về [] khi không kiểm tra được (không chạy bằng root): thà im lặng còn hơn
// báo động giả, vì cảnh báo sai vài lần là người dùng bỏ qua mọi cảnh báo sau đó.
function unreadableStaticApps(): { app: AppRecord; paths: string[] }[] {
  const nginxUser = nginxWorkerUser();
  const out: { app: AppRecord; paths: string[] }[] = [];
  for (const app of Object.values(loadState().apps)) {
    const paths = appServePaths(app).filter((p) => existsSync(p));
    if (paths.length === 0) continue;
    const bad = paths.filter((p) => pathReadableBy(nginxUser, p) === false);
    if (bad.length > 0) out.push({ app, paths: bad });
  }
  return out;
}

// App có thư mục tải lên nằm trong gốc tĩnh công khai mà nginx CHƯA phục vụ.
//
// Hỏng theo kiểu đặc biệt khó chẩn đoán: file tải lên TRƯỚC lần build gần nhất
// hiện bình thường (build sao chép 'static/'|'public/' vào output), file tải lên
// SAU đó trả 404 — rồi tự hiện ra sau lần deploy kế tiếp. Nhìn hệt như lỗi cache
// hoặc lỗi chập chờn, nên gần như không ai lần ra là do cấu hình nginx.
function uploadCandidates(): { app: AppRecord; dir: string; prefix: string }[] {
  const out: { app: AppRecord; dir: string; prefix: string }[] = [];
  for (const app of Object.values(loadState().apps)) {
    if (app.uploadDir) continue;
    const upload = detectUploadDir(unitWorkDir(app.webRoot, app.appDir));
    if (upload) out.push({ app, dir: upload.dir, prefix: upload.prefix });
  }
  return out;
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

    // --- asset tĩnh chưa bật ---
    const candidates = staticCandidates();
    const safe = candidates.filter((c) => !c.suggestion.risky);
    const risky = candidates.filter((c) => c.suggestion.risky);
    if (safe.length > 0) {
      findings.push({
        name: "nginx-static",
        ok: false,
        message:
          `${safe.length} app đang đẩy TOÀN BỘ asset tĩnh qua tiến trình Node ` +
          `(${safe.map((c) => `${c.app.domain}: ${c.suggestion.framework}`).join(", ")}). ` +
          `Mỗi trang kéo hàng trăm chunk .js/.css xếp hàng trên event loop đơn luồng — app chậm mà không có lỗi nào để lần. ` +
          `Sửa: ${safe.map((c) => `napp app set ${c.app.domain} --auto-static`).join(" · ")}`,
        fix: () => {
          for (const c of safe) cmdAppSet(c.app.domain, { autoStatic: true });
        },
      });
    }
    // Nhóm risky KHÔNG có fix: '/assets/' có thể là route thật của app, và
    // 'location ^~' thắng cả proxy_pass nên áp nhầm là route đó chết hẳn bằng
    // 404. Quyết định này thuộc về người biết app, không thuộc về --fix.
    for (const c of risky) {
      warn(
        `${c.app.domain}: nhận diện ${c.suggestion.framework} nhưng tiền tố ` +
          `'${c.suggestion.staticPrefixes.join(" ")}' có thể trùng route thật của app — napp KHÔNG tự áp.\n` +
          `  Kiểm tra app không dùng tiền tố đó làm route, rồi chạy:\n    ${staticSetCommand(c.app.domain, c.suggestion)}`
      );
    }

    // --- thư mục tải lên chưa được phục vụ ---
    const uploads = uploadCandidates();
    if (uploads.length > 0) {
      findings.push({
        name: "nginx-uploads",
        ok: false,
        message:
          `${uploads.length} app có thư mục file tải lên nằm trong gốc tĩnh công khai nhưng nginx CHƯA phục vụ ` +
          `(${uploads.map((u) => `${u.app.domain}: ${u.dir}`).join(", ")}). ` +
          `File tải lên SAU lần build gần nhất trả 404 dù có thật trên đĩa, rồi tự hiện ra sau lần deploy kế tiếp — ` +
          `trông hệt lỗi chập chờn. Sửa: ${uploads.map((u) => `napp app set ${u.app.domain} --upload-dir ${u.dir}`).join(" · ")}`,
        fix: () => {
          for (const u of uploads) cmdAppSet(u.app.domain, { uploadDir: u.dir, uploadPrefix: u.prefix });
        },
      });
    }

    // --- asset tĩnh đã bật nhưng nginx không đọc được ---
    const unreadable = unreadableStaticApps();
    if (unreadable.length > 0) {
      const nginxUser = nginxWorkerUser();
      findings.push({
        name: "nginx-static-perm",
        ok: false,
        message:
          `${unreadable.length} app có cấu hình asset tĩnh nhưng nginx (user '${nginxUser}') KHÔNG đọc được thư mục ` +
          `(${unreadable.map((u) => u.app.domain).join(", ")}). Thư mục app thuộc user riêng và để 750, nginx chạy bằng user khác nên ` +
          `không đi xuyên qua được — kết quả là 403 chứ không phải file, và log nginx ghi 'Permission denied' rất dễ đọc nhầm thành sai đường dẫn. ` +
          `Sửa: thêm '${nginxUser}' vào nhóm của từng app rồi restart nginx.`,
        fix: () => {
          for (const u of unreadable) {
            const res = grantNginxGroupAccess(u.app.user);
            if (res.changed) ok(`${u.app.domain}: ${res.message}`);
            else warn(`${u.app.domain}: ${res.message}`);
          }
        },
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

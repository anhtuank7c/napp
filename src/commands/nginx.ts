import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { execCapture, runCmd, requireRoot, ensureDir, writeFile, commandExists } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { ipv6Available } from "../lib/network";
import { loadState, NGINX_AVAILABLE } from "../lib/state";
import {
  renderNginxHardeningConf,
  renderDefaultServerConf,
  renderNappProxyConf,
  NGINX_DEFAULT_SERVER_CONF,
  NGINX_HARDENING_CONF,
  NGINX_PROXY_CONF,
} from "../templates/nginx";

const DEFAULT_DENY_CERT = "/etc/napp/default-deny.crt";
const DEFAULT_DENY_KEY = "/etc/napp/default-deny.key";

// ssl_reject_handshake có từ nginx 1.19.4. Máy cũ hơn phải dùng cert tự ký.
function nginxSupportsRejectHandshake(): boolean {
  const res = execCapture("nginx", ["-v"]); // "nginx version: nginx/1.24.0" (ra stderr)
  const m = `${res.stderr}${res.stdout}`.match(/nginx\/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const maj = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const patch = parseInt(m[3]!, 10);
  if (maj !== 1) return maj > 1;
  if (min !== 19) return min > 19;
  return patch >= 4;
}

function ensureSelfSignedCert(): { certPath: string; keyPath: string } {
  if (!existsSync(DEFAULT_DENY_CERT) || !existsSync(DEFAULT_DENY_KEY)) {
    if (!commandExists("openssl")) {
      die("Cần 'openssl' để tạo chứng chỉ tự ký cho server chặn. Cài: apt install -y openssl");
    }
    ensureDir("/etc/napp", 0o750);
    runCmd("openssl", [
      "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "3650",
      "-keyout", DEFAULT_DENY_KEY, "-out", DEFAULT_DENY_CERT,
      "-subj", "/CN=napp-default-deny",
    ]);
    runCmd("chmod", ["600", DEFAULT_DENY_KEY]);
  }
  return { certPath: DEFAULT_DENY_CERT, keyPath: DEFAULT_DENY_KEY };
}

// Ghi file map dùng chung (idempotent). PHẢI chạy TRƯỚC khi ghi bất kỳ vhost nào
// dùng $napp_connection_upgrade — thiếu file này thì `nginx -t` báo unknown variable.
export function ensureNappProxyConf(): boolean {
  const want = renderNappProxyConf();
  if (existsSync(NGINX_PROXY_CONF) && readFileSync(NGINX_PROXY_CONF, "utf8") === want) return false;
  ensureDir("/etc/nginx/conf.d", 0o755);
  writeFile(NGINX_PROXY_CONF, want, 0o644);
  return true;
}

// Bug cũ: vhost ép cứng 'Connection "upgrade"' cho MỌI request. Vá tại chỗ bằng
// phép thay chuỗi thay vì render lại cả file — render lại sẽ XOÁ SẠCH khối SSL mà
// certbot đã chèn vào vhost, làm sập HTTPS của site đang chạy.
const LEGACY_CONNECTION_LINE = /proxy_set_header\s+Connection\s+"upgrade"\s*;/g;

export function cmdNginxSync(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  section("Đồng bộ cấu hình proxy dùng chung cho các vhost napp");

  const wroteProxyConf = ensureNappProxyConf();
  info(wroteProxyConf ? `Đã ghi ${NGINX_PROXY_CONF} (map $napp_connection_upgrade).` : `${NGINX_PROXY_CONF} đã đúng, giữ nguyên.`);

  // Sao lưu trước khi vá để còn hoàn tác nếu nginx -t hỏng.
  const patched: string[] = [];
  const backups = new Map<string, string>();
  for (const domain of Object.keys(loadState().apps)) {
    const conf = `${NGINX_AVAILABLE}/${domain}.conf`;
    if (!existsSync(conf)) {
      warn(`Bỏ qua '${domain}': không thấy ${conf}.`);
      continue;
    }
    const before = readFileSync(conf, "utf8");
    const after = before.replace(LEGACY_CONNECTION_LINE, "proxy_set_header Connection $napp_connection_upgrade;");
    if (after === before) continue;
    const bak = `${conf}.napp-bak`;
    copyFileSync(conf, bak);
    backups.set(conf, bak);
    writeFile(conf, after, 0o644);
    patched.push(domain);
  }

  if (patched.length === 0) {
    info("Không có vhost nào cần vá (tất cả đã dùng $napp_connection_upgrade).");
  } else {
    info(`Đã vá header Connection cho: ${patched.join(", ")}`);
  }

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    for (const [conf, bak] of backups) copyFileSync(bak, conf);
    if (wroteProxyConf) runCmd("rm", ["-f", NGINX_PROXY_CONF], { silentFail: true });
    die(`Cấu hình nginx sau khi vá có lỗi — ĐÃ HOÀN TÁC toàn bộ:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  for (const bak of backups.values()) runCmd("rm", ["-f", bak], { silentFail: true });

  ok("Đã đồng bộ và reload nginx.");
  info("• 'Connection: upgrade' giờ CHỈ gửi cho request WebSocket thật; request thường dùng keep-alive.");
  info("• Khối SSL do certbot chèn trong vhost được giữ nguyên (vá tại chỗ, không render lại).");
}

export function cmdNginxHarden(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  section("Hardening nginx + chặn truy cập IP / Host lạ");

  ensureDir("/etc/nginx/conf.d", 0o755);

  // Gỡ site 'default' mặc định của Ubuntu (nó cũng là default_server, sẽ gây lỗi
  // "duplicate default server" với server mặc định của napp). Chỉ gỡ symlink
  // trong sites-enabled — file nguồn trong sites-available vẫn còn.
  const stockDefault = "/etc/nginx/sites-enabled/default";
  if (existsSync(stockDefault)) {
    runCmd("rm", ["-f", stockDefault], { silentFail: true });
    info("Đã vô hiệu site 'default' mặc định của Ubuntu (gỡ symlink sites-enabled/default).");
  }

  const ipv6 = ipv6Available();
  const sslMode = nginxSupportsRejectHandshake() ? "reject" : "selfsigned";
  let certPath: string | undefined;
  let keyPath: string | undefined;
  if (sslMode === "selfsigned") {
    ({ certPath, keyPath } = ensureSelfSignedCert());
    info("nginx < 1.19.4 — dùng chứng chỉ tự ký cho server chặn HTTPS (thay ssl_reject_handshake).");
  }

  writeFile(NGINX_HARDENING_CONF, renderNginxHardeningConf(), 0o644);
  writeFile(NGINX_DEFAULT_SERVER_CONF, renderDefaultServerConf({ ipv6, sslMode, certPath, keyPath }), 0o644);

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    // Hoàn tác file vừa ghi để KHÔNG làm hỏng nginx khi reload sau này.
    runCmd("rm", ["-f", NGINX_DEFAULT_SERVER_CONF, NGINX_HARDENING_CONF], { silentFail: true });
    die(`Cấu hình nginx sau hardening có lỗi — ĐÃ HOÀN TÁC (gỡ file vừa ghi):\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);

  ok("Đã bật hardening nginx.");
  info("• Request tới IP máy chủ hoặc Host KHÔNG khớp domain nào -> bị chặn (HTTP 444: đóng kết nối).");
  info("• Chỉ domain đã tạo app (server_name khớp) mới truy cập được.");
  info("• Đã ẩn phiên bản nginx (server_tokens off).");
  warn("Nếu bạn có dịch vụ khác cần truy cập qua IP trực tiếp, hãy cân nhắc trước — hoặc 'napp nginx unharden' để gỡ.");
}

export function cmdNginxUnharden(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài.");
  let removed = false;
  for (const f of [NGINX_DEFAULT_SERVER_CONF, NGINX_HARDENING_CONF]) {
    if (existsSync(f)) {
      runCmd("rm", ["-f", f], { silentFail: true });
      removed = true;
    }
  }
  if (!removed) {
    info("Không có cấu hình hardening nào của napp để gỡ.");
    return;
  }
  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) die(`Cấu hình nginx sau khi gỡ có lỗi:\n${test.stderr}`);
  runCmd("systemctl", ["reload", "nginx"]);
  ok("Đã gỡ hardening nginx (server chặn IP/Host lạ). Truy cập IP trực tiếp sẽ theo hành vi mặc định của nginx trở lại.");
}

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

/**
 * Gỡ khối bộ đệm proxy nội tuyến khỏi một vhost cũ.
 *
 * Từ 1.20.0 bộ đệm nằm ở mức http trong 00-napp-proxy.conf. Vhost tạo bằng bản
 * cũ vẫn mang `proxy_buffer_size 16k` ngay trong `location /`, mà giá trị trong
 * location LUÔN THẮNG giá trị mức http — không gỡ đi thì site cũ vẫn 502 ở các
 * route sâu dù file dùng chung đã đúng.
 *
 * Cắt theo DÒNG chứ không bằng một regex nuốt cả khối: vhost là chỗ certbot
 * chèn khối SSL vào, một regex tham lam trượt tay ở đây là mất HTTPS của site
 * đang chạy. Ở đây chỉ những dòng `proxy_buffer*` (và chú thích dính liền
 * chúng) bị xoá, mọi dòng khác được chép nguyên văn.
 */
export function stripInlineProxyBuffers(content: string): { out: string; changed: boolean } {
  const lines = content.split("\n");
  const isBufferLine = (l: string) => /^\s*proxy_(buffering|buffer_size|buffers|busy_buffers_size)\s+[^;]*;\s*$/.test(l);
  const isComment = (l: string) => /^\s*#/.test(l);
  const keep: string[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    if (!isBufferLine(lines[i]!)) {
      keep.push(lines[i]!);
      continue;
    }
    changed = true;
    // Chú thích ngay TRÊN khối là chú thích giải thích các con số vừa bị gỡ —
    // giữ lại là để file nói dối về cấu hình thật.
    while (keep.length > 0 && isComment(keep[keep.length - 1]!)) keep.pop();

    // Nuốt tiếp phần còn lại của khối: dòng bộ đệm kế tiếp, và chú thích xen
    // giữa CHỈ KHI sau chúng vẫn còn dòng bộ đệm — nếu không, chú thích đó là
    // của directive khác và phải giữ nguyên.
    let j = i + 1;
    while (j < lines.length) {
      if (isBufferLine(lines[j]!)) {
        i = j;
        j = i + 1;
        continue;
      }
      if (isComment(lines[j]!)) {
        let k = j;
        while (k < lines.length && isComment(lines[k]!)) k++;
        if (k < lines.length && isBufferLine(lines[k]!)) {
          i = k;
          j = i + 1;
          continue;
        }
      }
      break;
    }
  }
  return { out: keep.join("\n"), changed };
}

export function cmdNginxSync(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  section("Đồng bộ cấu hình proxy dùng chung cho các vhost napp");

  const wroteProxyConf = ensureNappProxyConf();
  info(wroteProxyConf ? `Đã ghi ${NGINX_PROXY_CONF} (map $napp_connection_upgrade).` : `${NGINX_PROXY_CONF} đã đúng, giữ nguyên.`);

  // Sao lưu trước khi vá để còn hoàn tác nếu nginx -t hỏng.
  const patched: string[] = [];
  const debuffered: string[] = [];
  const backups = new Map<string, string>();
  for (const domain of Object.keys(loadState().apps)) {
    const conf = `${NGINX_AVAILABLE}/${domain}.conf`;
    if (!existsSync(conf)) {
      warn(`Bỏ qua '${domain}': không thấy ${conf}.`);
      continue;
    }
    const before = readFileSync(conf, "utf8");
    const withConnection = before.replace(LEGACY_CONNECTION_LINE, "proxy_set_header Connection $napp_connection_upgrade;");
    const stripped = stripInlineProxyBuffers(withConnection);
    if (stripped.changed) debuffered.push(domain);
    const after = stripped.out;
    if (after === before) continue;
    const bak = `${conf}.napp-bak`;
    copyFileSync(conf, bak);
    backups.set(conf, bak);
    writeFile(conf, after, 0o644);
    patched.push(domain);
  }

  if (patched.length === 0) {
    info("Không có vhost nào cần vá.");
  } else {
    info(`Đã vá vhost: ${patched.join(", ")}`);
  }
  if (debuffered.length > 0) {
    info(`Đã gỡ khối bộ đệm proxy nội tuyến (nay lấy từ ${NGINX_PROXY_CONF}) khỏi: ${debuffered.join(", ")}`);
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
  info("• Bộ đệm proxy: 128k header + 4x256k thân, đặt một chỗ ở mức http — đủ cho route SvelteKit lồng sâu (trước đây 502 'upstream sent too big header').");
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

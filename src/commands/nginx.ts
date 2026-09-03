import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { execCapture, runCmd, requireRoot, ensureDir, writeFile, commandExists, state as execState } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { ipv6Available } from "../lib/network";
import { loadState, slugFor, NGINX_AVAILABLE, type AppRecord } from "../lib/state";
import { writeAppLocationsConf, injectLocationsInclude } from "../lib/locationsfile";
import {
  renderNginxHardeningConf,
  renderDefaultServerConf,
  renderNappProxyConf,
  renderScannerBlockConf,
  appLocationsPath,
  appCustomLocationsPath,
  NGINX_DEFAULT_SERVER_CONF,
  NGINX_HARDENING_CONF,
  NGINX_PROXY_CONF,
  NGINX_LOCATIONS_DIR,
  NGINX_SCANNER_BLOCK_CONF,
  NGINX_SCANNER_LOG,
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

/**
 * Gom mọi file cấu hình bị đụng trong MỘT lệnh để `nginx -t` hỏng thì hoàn tác
 * được TẤT CẢ, không phải chỉ phần cuối cùng.
 *
 * Cần đến mức này vì một lần `napp nginx sync` nay chạm tới bốn loại file
 * (00-napp-proxy.conf, _scanner-block.conf, <domain>.conf, vhost) nhân với số
 * app. Hoàn tác nửa vời ở đây không phải "mất cấu hình" mà là nginx KHÔNG NẠP
 * ĐƯỢC — vd vhost đã có dòng `include` còn file được include thì vừa bị xoá —
 * và nginx không nạp được nghĩa là MỌI site trên máy tắt, không riêng site nào.
 *
 * Phân biệt hai trạng thái, vì hoàn tác của chúng ngược nhau:
 *   - file ĐÃ CÓ trước lệnh -> chép bản sao trả lại
 *   - file CHƯA CÓ (do chính lệnh này tạo ra) -> hoàn tác là XOÁ nó đi
 */
export class ConfigTx {
  private items: { path: string; backup?: string }[] = [];

  /**
   * Ghi nhớ trạng thái file. PHẢI gọi TRƯỚC khi ghi đè nó.
   *
   * copyFileSync là lệnh ghi THẬT, không đi qua writeFile/runCmd nên KHÔNG tự
   * biết --dry-run. Thiếu nhánh dryRun ở đây thì `napp nginx sync --dry-run`
   * rải '.napp-bak' khắp /etc/nginx rồi bỏ lại: bước dọn dẹp đi qua runCmd, mà
   * runCmd ở chế độ dry-run chỉ in ra chứ không xoá. Một lệnh mang tiếng "không
   * thay đổi gì" mà để lại rác là kiểu vi phạm hợp đồng khó chịu nhất.
   */
  track(path: string): void {
    if (this.items.some((i) => i.path === path)) return; // đã theo dõi -> giữ bản sao ĐẦU TIÊN
    if (!existsSync(path)) {
      this.items.push({ path });
      return;
    }
    const backup = `${path}.napp-bak`;
    if (!execState.dryRun) copyFileSync(path, backup);
    this.items.push({ path, backup });
  }

  rollback(): void {
    for (const it of this.items) {
      if (it.backup) {
        if (!execState.dryRun) copyFileSync(it.backup, it.path);
      } else {
        runCmd("rm", ["-f", it.path], { silentFail: true });
      }
    }
    this.cleanup();
  }

  /** Xoá các bản sao sau khi đã chắc chắn thành công. */
  cleanup(): void {
    for (const it of this.items) if (it.backup) runCmd("rm", ["-f", it.backup], { silentFail: true });
    this.items = [];
  }
}

/** Chặn quét lỗ hổng đang BẬT hay TẮT — trạng thái nằm trọn trong nội dung file. */
export function scannerBlockEnabled(): boolean {
  if (!existsSync(NGINX_SCANNER_BLOCK_CONF)) return false;
  // Bản TẮT chỉ có dòng chú thích; bản BẬT có các khối `location`.
  return /^\s*location\s/m.test(readFileSync(NGINX_SCANNER_BLOCK_CONF, "utf8"));
}

/**
 * Ghi file chặn quét lỗ hổng. Trả về true nếu nội dung thực sự đổi.
 *
 * TẮT = ghi bản RỖNG (chỉ chú thích), KHÔNG xoá file: nó đang được mọi vhost
 * include, mà include trỏ vào file không có thật thì nginx từ chối khởi động
 * trên toàn máy. Nhờ vậy trạng thái bật/tắt không cần lưu vào state.json —
 * nội dung của đúng một file là nguồn sự thật duy nhất.
 */
function ensureScannerBlockConf(enabled: boolean): boolean {
  const want = renderScannerBlockConf(enabled);
  if (existsSync(NGINX_SCANNER_BLOCK_CONF) && readFileSync(NGINX_SCANNER_BLOCK_CONF, "utf8") === want) return false;
  ensureDir(NGINX_LOCATIONS_DIR, 0o755);
  writeFile(NGINX_SCANNER_BLOCK_CONF, want, 0o644);
  return true;
}

interface BackfillResult {
  wroteLocations: boolean;
  patchedVhost: boolean;
}

/**
 * Đưa MỘT app về đúng cấu trúc file của bản napp hiện tại.
 *
 * Đây là phần dành cho app tạo bằng bản napp CŨ. Cơ chế "file location riêng +
 * một dòng include" chỉ có từ 1.19.0; app tạo trước đó có vhost KHÔNG hề chứa
 * dòng include nào, nên mọi thứ napp ghi vào '/etc/nginx/napp-locations/' đều
 * không tới được chúng — kể cả chặn quét lỗ hổng. Hỏng kiểu im lặng hoàn hảo:
 * `nginx -t` xanh, lệnh báo thành công, mà site cũ thì không được bảo vệ gì cả.
 *
 * Hai bước, đều idempotent:
 *   1. ghi/tạo '<domain>.conf' từ registry (kèm sidecar '<domain>.custom.conf')
 *   2. chèn ĐÚNG MỘT dòng `include` vào vhost nếu chưa có — chèn bằng phép cắt
 *      chuỗi theo khối server, KHÔNG render lại vhost, vì certbot chèn khối SSL
 *      thẳng vào đó và render lại là xoá HTTPS của site đang chạy.
 */
function backfillAppLocations(app: AppRecord, tx: ConfigTx): BackfillResult {
  const locPath = appLocationsPath(app.domain);
  const before = existsSync(locPath) ? readFileSync(locPath, "utf8") : null;
  tx.track(locPath);
  tx.track(appCustomLocationsPath(app.domain));
  writeAppLocationsConf(app);
  const wroteLocations = before !== readFileSync(locPath, "utf8");

  const vhostPath = `${NGINX_AVAILABLE}/${app.domain}.conf`;
  const vhost = readFileSync(vhostPath, "utf8");
  const withInclude = injectLocationsInclude(vhost, `proxy_pass http://napp_${slugFor(app.domain)}`, `include ${locPath};`);
  if (withInclude === vhost) return { wroteLocations, patchedVhost: false };

  tx.track(vhostPath);
  writeFile(vhostPath, withInclude, 0o644);
  return { wroteLocations, patchedVhost: true };
}

/** App đang TẮT chặn quét lỗ hổng riêng lẻ (`napp app set <domain> --no-scan-block`). */
function appsWithScanBlockOff(): string[] {
  return Object.values(loadState().apps)
    .filter((a) => a.scanBlock === false)
    .map((a) => a.domain);
}

export function cmdNginxSync(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  section("Đồng bộ cấu hình nginx dùng chung cho các vhost napp");

  const tx = new ConfigTx();

  tx.track(NGINX_PROXY_CONF);
  const wroteProxyConf = ensureNappProxyConf();
  info(
    wroteProxyConf
      ? `Đã ghi ${NGINX_PROXY_CONF} (map $napp_connection_upgrade + log_format napp_scan).`
      : `${NGINX_PROXY_CONF} đã đúng, giữ nguyên.`
  );

  // Chặn quét lỗ hổng: lần đầu (file chưa có) thì BẬT. Đã có thì GIỮ NGUYÊN
  // trạng thái hiện tại — người dùng chạy `napp nginx unscanblock` có lý do của
  // họ, và `sync` là lệnh chạy đi chạy lại sau mỗi lần nâng cấp; bật lại sau
  // lưng họ mỗi lần như vậy là cách chắc chắn nhất để một quyết định có chủ đích
  // bị xoá mà không ai thấy.
  const scannerExisted = existsSync(NGINX_SCANNER_BLOCK_CONF);
  const scannerOn = scannerExisted ? scannerBlockEnabled() : true;
  tx.track(NGINX_SCANNER_BLOCK_CONF);
  ensureScannerBlockConf(scannerOn);

  const patched: string[] = [];
  const debuffered: string[] = [];
  const includeAdded: string[] = [];
  const locationsWritten: string[] = [];

  for (const app of Object.values(loadState().apps)) {
    const conf = `${NGINX_AVAILABLE}/${app.domain}.conf`;
    if (!existsSync(conf)) {
      warn(`Bỏ qua '${app.domain}': không thấy ${conf}.`);
      continue;
    }

    // (a) Vá tại chỗ các chỉ thị đã lỗi thời NẰM TRONG vhost.
    const before = readFileSync(conf, "utf8");
    const withConnection = before.replace(LEGACY_CONNECTION_LINE, "proxy_set_header Connection $napp_connection_upgrade;");
    const stripped = stripInlineProxyBuffers(withConnection);
    if (stripped.changed) debuffered.push(app.domain);
    if (stripped.out !== before) {
      tx.track(conf);
      writeFile(conf, stripped.out, 0o644);
      patched.push(app.domain);
    }

    // (b) File location + dòng include — phần vá cho app tạo bằng bản napp cũ.
    const res = backfillAppLocations(app, tx);
    if (res.wroteLocations) locationsWritten.push(app.domain);
    if (res.patchedVhost) includeAdded.push(app.domain);
  }

  info(patched.length === 0 ? "Không có vhost nào cần vá chỉ thị cũ." : `Đã vá chỉ thị cũ trong vhost: ${patched.join(", ")}`);
  if (debuffered.length > 0) {
    info(`Đã gỡ khối bộ đệm proxy nội tuyến (nay lấy từ ${NGINX_PROXY_CONF}) khỏi: ${debuffered.join(", ")}`);
  }
  if (includeAdded.length > 0) {
    info(`Đã chèn dòng 'include' file location vào vhost CHƯA có (app tạo bằng bản napp cũ): ${includeAdded.join(", ")}`);
  }
  if (locationsWritten.length > 0) {
    info(`Đã cập nhật file location: ${locationsWritten.join(", ")}`);
  }

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    tx.rollback();
    die(`Cấu hình nginx sau khi vá có lỗi — ĐÃ HOÀN TÁC toàn bộ:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  tx.cleanup();

  ok("Đã đồng bộ và reload nginx.");
  info("• 'Connection: upgrade' giờ CHỈ gửi cho request WebSocket thật; request thường dùng keep-alive.");
  info("• Bộ đệm proxy: 128k header + 4x256k thân, đặt một chỗ ở mức http — đủ cho route SvelteKit lồng sâu (trước đây 502 'upstream sent too big header').");
  info("• Khối SSL do certbot chèn trong vhost được giữ nguyên (vá tại chỗ, không render lại).");
  if (scannerOn) {
    reportScannerBlock(scannerExisted ? "giữ nguyên (đang BẬT)" : "BẬT lần đầu");
  } else {
    info(`• Chặn quét lỗ hổng: đang TẮT (giữ nguyên lựa chọn cũ). Bật lại: napp nginx scanblock`);
  }
}

/** Phần báo cáo dùng chung cho `nginx sync` và `nginx scanblock`. */
function reportScannerBlock(stateLabel: string): void {
  info(`• Chặn quét lỗ hổng: ${stateLabel} — '.php/.asp/.jsp', '/wp-admin/', '/phpmyadmin/', '/cgi-bin/' -> 444, KHÔNG qua Node.`);
  info(`  Ghi log riêng ở ${NGINX_SCANNER_LOG} (access log của site sạch trở lại): tail -f ${NGINX_SCANNER_LOG}`);
  info(`  Chạy 'napp fail2ban setup' để bật jail 'napp-scanner' — ban IP ngay từ tường lửa, thứ THẬT SỰ tiết kiệm tài nguyên (444 vẫn phải trả tiền bắt tay TLS).`);
  const off = appsWithScanBlockOff();
  if (off.length > 0) info(`  Đang TẮT riêng cho: ${off.join(", ")} (bật lại: napp app set <domain> --scan-block)`);
}

export function cmdNginxScanBlock(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  section("Chặn quét lỗ hổng CMS/framework PHP (trả 444, log riêng)");

  const tx = new ConfigTx();

  // log_format napp_scan nằm trong file này và PHẢI được nginx đọc TRƯỚC khi
  // gặp `access_log ... napp_scan` trong vhost — thiếu nó thì `nginx -t` báo
  // "unknown log format". conf.d được nginx.conf include trước sites-enabled
  // nên thứ tự đã đúng sẵn; ở đây chỉ cần bảo đảm file có mặt.
  tx.track(NGINX_PROXY_CONF);
  ensureNappProxyConf();

  tx.track(NGINX_SCANNER_BLOCK_CONF);
  ensureScannerBlockConf(true);

  // Ghi file thôi là chưa đủ: vhost của app tạo bằng bản napp cũ không có dòng
  // include nào trỏ tới nó. Không có bước này thì lệnh báo thành công còn các
  // site cũ — đúng những site đã chạy lâu nhất và bị quét nhiều nhất — vẫn để
  // ngỏ hoàn toàn.
  const includeAdded: string[] = [];
  const touched: string[] = [];
  for (const app of Object.values(loadState().apps)) {
    if (!existsSync(`${NGINX_AVAILABLE}/${app.domain}.conf`)) {
      warn(`Bỏ qua '${app.domain}': không thấy vhost ${NGINX_AVAILABLE}/${app.domain}.conf.`);
      continue;
    }
    const res = backfillAppLocations(app, tx);
    if (res.patchedVhost) includeAdded.push(app.domain);
    if (res.wroteLocations || res.patchedVhost) touched.push(app.domain);
  }

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    tx.rollback();
    die(`Cấu hình nginx sau khi bật chặn quét có lỗi — ĐÃ HOÀN TÁC toàn bộ:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  tx.cleanup();

  ok("Đã bật chặn quét lỗ hổng cho mọi site napp quản lý.");
  if (includeAdded.length > 0) {
    info(`• Đã chèn dòng 'include' vào vhost chưa có (app tạo bằng bản napp cũ): ${includeAdded.join(", ")}`);
  }
  if (touched.length === 0) info("• Mọi site đã ở đúng cấu hình, không có gì phải đổi.");
  reportScannerBlock("BẬT");
  warn("Danh sách mẫu cố ý HẸP (neo theo đuôi .php/.asp/.jsp và namespace WordPress/phpMyAdmin) để không thể chặn nhầm route thật của app Node.");
  warn(`Nếu một site của bạn THẬT SỰ phục vụ file .php qua upstream khác: napp app set <domain> --no-scan-block`);
}

export function cmdNginxUnscanBlock(): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài.");
  if (!existsSync(NGINX_SCANNER_BLOCK_CONF)) {
    info("Chặn quét lỗ hổng chưa từng được bật — không có gì để gỡ.");
    return;
  }
  if (!scannerBlockEnabled()) {
    info("Chặn quét lỗ hổng đang TẮT sẵn. Bật lại: napp nginx scanblock");
    return;
  }

  const tx = new ConfigTx();
  tx.track(NGINX_SCANNER_BLOCK_CONF);
  // Làm RỖNG chứ KHÔNG xoá — mọi vhost đang include file này, xoá nó là nginx
  // từ chối khởi động và sập toàn bộ site trên máy. Giữ file lại cũng có nghĩa
  // là bật lại sau này chỉ là ghi đè một file, không phải vá lại N vhost.
  ensureScannerBlockConf(false);

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    tx.rollback();
    die(`Cấu hình nginx sau khi gỡ có lỗi — ĐÃ HOÀN TÁC:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  tx.cleanup();

  ok("Đã tắt chặn quét lỗ hổng. Request dò .php/wp-admin lại đi qua Node và quay lại access log của site.");
  info(`• Dòng 'include ${NGINX_SCANNER_BLOCK_CONF};' vẫn nằm trong vhost (file nay rỗng) — bật lại chỉ cần: napp nginx scanblock`);
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

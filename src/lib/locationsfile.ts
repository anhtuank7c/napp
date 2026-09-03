import { existsSync, readFileSync } from "node:fs";
import { writeFile, ensureDir, runCmd } from "./exec";
import { warn, info } from "./log";
import type { AppRecord } from "./state";
import {
  renderAppLocationsConf,
  renderScannerBlockConf,
  appLocationsPath,
  appCustomLocationsPath,
  NGINX_LOCATIONS_DIR,
  NGINX_SCANNER_BLOCK_CONF,
} from "../templates/nginx";

/**
 * Ghi file location của app mà KHÔNG âm thầm nuốt mất phần người dùng thêm tay.
 *
 * BỐI CẢNH — vì sao cần hàm này:
 *
 * File '/etc/nginx/napp-locations/<domain>.conf' được render lại TOÀN BỘ từ
 * registry ở BA chỗ khác nhau: 'app create', 'app set', và 'domain add/remove'.
 * Đầu file ghi "TỰ SINH, đừng sửa tay", nhưng nó đồng thời là chỗ DUY NHẤT
 * người dùng có thể đặt location riêng — nên ai cần một location napp chưa hỗ
 * trợ đều buộc phải sửa vào đây. Lần chạy kế tiếp của bất kỳ lệnh nào trong ba
 * lệnh trên xoá sạch phần đó, KHÔNG cảnh báo, và triệu chứng chỉ hiện ra sau đó
 * rất lâu — ảnh vỡ, route trả 404 — vào một thời điểm không liên quan gì tới
 * lệnh đã gây ra nó.
 *
 * Hai lớp giải quyết:
 *
 *   1. FILE SIDECAR '<domain>.custom.conf' — napp include nó vào cuối file tự
 *      sinh và KHÔNG BAO GIỜ ghi đè. Đây là chỗ ĐÚNG để đặt location riêng.
 *   2. CẢNH BÁO KHI SẮP MẤT — trước khi ghi đè, so tập tiền tố 'location ^~'
 *      của file cũ với file mới. Tiền tố nào biến mất là dấu hiệu chắc chắn có
 *      thứ sắp bị xoá: hoặc người dùng thêm tay, hoặc cấu hình trong registry
 *      đã rơi mất. Cả hai đều đáng dừng lại để nói ra.
 *
 * Vì sao so TIỀN TỐ chứ không dùng fingerprint như unit systemd: file location
 * của các app tạo bằng bản napp cũ không có fingerprint nào cả, nên mọi app
 * đang chạy sẽ bị coi là "đã sửa tay" ngay lần nâng cấp đầu tiên — cảnh báo sai
 * hàng loạt, và người dùng học được cách bỏ qua cảnh báo của napp. So tiền tố
 * thì không cần lịch sử: nó chỉ nói đúng một điều, rằng thứ đang được phục vụ
 * sắp không còn được phục vụ nữa.
 */

/** Mọi tiền tố trong 'location ^~ <tiền-tố> {' của một file cấu hình. */
export function locationPrefixesIn(conf: string): string[] {
  const out: string[] = [];
  const re = /location\s+\^~\s+(\S+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(conf)) !== null) out.push(m[1]!);
  return out;
}

/**
 * File sidecar cho location người dùng tự viết.
 *
 * PHẢI tồn tại trước khi nginx nạp: file tự sinh `include` nó, và nginx TỪ CHỐI
 * KHỞI ĐỘNG nếu include trỏ vào file không có thật — sập nginx của TOÀN MÁY chứ
 * không riêng site này. Nên hàm này tạo bản rỗng (chỉ chú thích) khi thiếu, và
 * tuyệt đối không đụng tới nội dung nếu file đã có.
 */
export function ensureCustomLocationsFile(domain: string): void {
  const path = appCustomLocationsPath(domain);
  if (existsSync(path)) return;
  writeFile(
    path,
    `# Location RIÊNG của bạn cho ${domain} — napp KHÔNG BAO GIỜ ghi đè file này.\n` +
      `#\n` +
      `# File '<domain>.conf' bên cạnh là file TỰ SINH: 'napp app set' và\n` +
      `# 'napp domain add' render lại toàn bộ nó từ registry, nên mọi thứ bạn thêm\n` +
      `# vào đó sẽ biến mất. Đặt location riêng vào ĐÂY thì chúng tồn tại mãi.\n` +
      `#\n` +
      `# File này được include BÊN TRONG khối 'server' của vhost, nên viết thẳng\n` +
      `# các khối 'location ...' là được. Nhớ chạy 'nginx -t' trước khi reload.\n`,
    0o644
  );
}

/**
 * File chặn quét lỗ hổng DÙNG CHUNG — bảo đảm nó có mặt trước khi ai đó include.
 *
 * Cùng một cái bẫy như ensureCustomLocationsFile, nhưng hậu quả rộng hơn: file
 * location của MỌI app đều include file này, nên thiếu nó thì nginx không nạp
 * được cấu hình và TẤT CẢ site trên máy tắt — chỉ vì vừa tạo thêm một app.
 *
 * Đặt ở đây, trong hàm DUY NHẤT từng ghi ra dòng include, thay vì bắt từng chỗ
 * gọi ('app create', 'app set', 'domain add/remove') nhớ gọi thêm một hàm nữa:
 * chỗ gọi thứ tư quên là lại sập, mà lần đó sẽ không ai nối được với thay đổi
 * này nữa.
 *
 * KHÔNG ghi đè khi file đã có — người dùng có thể vừa chạy 'napp nginx
 * unscanblock', và tạo một app mới không phải là lý do để đảo ngược việc đó.
 */
export function ensureScannerBlockFile(): void {
  if (existsSync(NGINX_SCANNER_BLOCK_CONF)) return;
  writeFile(NGINX_SCANNER_BLOCK_CONF, renderScannerBlockConf(true), 0o644);
}

/**
 * Ghi file location của app. Dùng CHUNG cho cả ba chỗ render lại nó, để việc
 * cảnh báo không phụ thuộc vào chỗ gọi nào nhớ làm.
 */
export function writeAppLocationsConf(app: AppRecord): void {
  ensureDir(NGINX_LOCATIONS_DIR, 0o755);
  ensureCustomLocationsFile(app.domain);
  ensureScannerBlockFile();

  const path = appLocationsPath(app.domain);
  const rendered = renderAppLocationsConf(app);

  if (existsSync(path)) {
    const previous = readFileSync(path, "utf8");
    const before = locationPrefixesIn(previous);
    const after = new Set(locationPrefixesIn(rendered));
    const lost = before.filter((p) => !after.has(p));
    if (lost.length > 0) {
      // Sao lưu TRƯỚC khi ghi đè, và nói ra đường dẫn: mất một khối cấu hình mà
      // không có bản sao là hỏng không hoàn tác được.
      const bak = `${path}.napp-orphaned`;
      runCmd("cp", ["-a", path, bak], { silentFail: true });
      warn(
        `${path}: ghi đè sẽ XOÁ ${lost.length} location đang phục vụ (${lost.join(" ")}).\n` +
          `  Bản sao đầy đủ của file cũ: ${bak}\n` +
          `  Nếu đó là location BẠN thêm tay: chuyển nó sang ${appCustomLocationsPath(app.domain)} — napp không bao giờ ghi đè file đó.\n` +
          `  Nếu đó là cấu hình napp (vd '/uploads/'): khai báo lại bằng 'napp app set ${app.domain} --upload-dir <thư-mục>' để nó nằm trong registry.`
      );
    }
  }

  writeFile(path, rendered, 0o644);
}

// Nằm ở lib chứ không ở commands/app.ts vì cả `napp app set` lẫn `napp nginx sync`
// đều cần nó (sync dùng để vá vhost của app tạo bằng bản napp cũ, chưa hề có dòng
// include nào), mà commands/app.ts đã import commands/nginx.ts — để hàm ở đó là
// tạo ra một vòng import giữa hai file lệnh.
/** Chèn `include <file>;` vào MỌI khối server đang proxy tới upstream của app. */
export function injectLocationsInclude(conf: string, upstreamMarker: string, includeLine: string): string {
  if (conf.includes(includeLine)) return conf; // đã có -> idempotent
  const out: string[] = [];
  let i = 0;
  while (i < conf.length) {
    const at = conf.indexOf("server", i);
    if (at === -1) {
      out.push(conf.slice(i));
      break;
    }
    const open = conf.indexOf("{", at);
    if (open === -1) {
      out.push(conf.slice(i));
      break;
    }
    // Tìm dấu } đóng khối bằng cách đếm ngoặc — không thể dùng regex vì khối
    // server chứa các khối location lồng bên trong.
    let depth = 0;
    let end = -1;
    for (let k = open; k < conf.length; k++) {
      if (conf[k] === "{") depth++;
      else if (conf[k] === "}") {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) {
      out.push(conf.slice(i));
      break;
    }
    const block = conf.slice(at, end + 1);
    out.push(conf.slice(i, at));
    if (block.includes(upstreamMarker)) {
      // Chèn NGAY TRƯỚC dấu đóng khối. Cuối khối chứ không phải đầu: một số
      // chỉ thị đơn (client_max_body_size...) lấy lần khai báo SAU CÙNG, nên
      // chèn ở đầu sẽ bị chính vhost ghi đè lại ngay bên dưới.
      out.push(block.slice(0, -1).replace(/\s*$/, "\n") + `\n    ${includeLine}\n}`);
    } else {
      out.push(block);
    }
    i = end + 1;
  }
  return out.join("");
}

/** In gợi ý về sidecar — dùng sau khi ghi, khi người dùng vừa đụng tới file này. */
export function hintCustomLocations(domain: string): void {
  info(`• Location tự viết (napp không đụng tới): ${appCustomLocationsPath(domain)}`);
}

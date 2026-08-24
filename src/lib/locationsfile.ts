import { existsSync, readFileSync } from "node:fs";
import { writeFile, ensureDir, runCmd } from "./exec";
import { warn, info } from "./log";
import type { AppRecord } from "./state";
import { renderAppLocationsConf, appLocationsPath, appCustomLocationsPath, NGINX_LOCATIONS_DIR } from "../templates/nginx";

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
 * Ghi file location của app. Dùng CHUNG cho cả ba chỗ render lại nó, để việc
 * cảnh báo không phụ thuộc vào chỗ gọi nào nhớ làm.
 */
export function writeAppLocationsConf(app: AppRecord): void {
  ensureDir(NGINX_LOCATIONS_DIR, 0o755);
  ensureCustomLocationsFile(app.domain);

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

/** In gợi ý về sidecar — dùng sau khi ghi, khi người dùng vừa đụng tới file này. */
export function hintCustomLocations(domain: string): void {
  info(`• Location tự viết (napp không đụng tới): ${appCustomLocationsPath(domain)}`);
}

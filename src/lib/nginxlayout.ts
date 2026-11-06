import { existsSync, readFileSync } from "node:fs";
import { ensureDir, writeFile, state as execState } from "./exec";
import { info } from "./log";
import { isRhel } from "./platform";
import { NGINX_AVAILABLE, NGINX_ENABLED } from "./state";

// --------------------------------------------------------------------------
// Bố cục thư mục nginx.
//
// Ubuntu/Debian: nginx.conf include sẵn sites-enabled/* — napp dùng nguyên.
// Họ RHEL: chỉ có conf.d/*.conf. Thay vì rẽ nhánh mọi chỗ ghi vhost, napp tạo
// cùng cấu trúc sites-available/sites-enabled và include nó từ conf.d. Tên
// 'zz-' để nạp SAU mọi file conf.d khác — đúng thứ tự như trên Ubuntu
// (nginx.conf include conf.d trước, sites-enabled sau).
// --------------------------------------------------------------------------

export const NGINX_SITES_INCLUDE = "/etc/nginx/conf.d/zz-napp-sites.conf";
const NGINX_MAIN_CONF = "/etc/nginx/nginx.conf";

const SITES_INCLUDE = `# Managed by napp — họ RHEL không có sites-enabled; napp tạo và include ở đây.
include ${NGINX_ENABLED}/*.conf;
`;

/** Họ RHEL thiếu cấu trúc sites-* của napp không. */
export function nginxLayoutMissing(): boolean {
  if (!isRhel()) return false;
  return !existsSync(NGINX_ENABLED) || !existsSync(NGINX_SITES_INCLUDE) || readFileSync(NGINX_SITES_INCLUDE, "utf8") !== SITES_INCLUDE;
}

/**
 * Bảo đảm vhost của napp được nginx nạp. Idempotent; không làm gì trên Ubuntu.
 * Trả về true nếu có thay đổi (caller tự reload nginx).
 */
export function ensureNginxLayout(): boolean {
  if (!isRhel()) return false;
  let changed = false;
  ensureDir(NGINX_AVAILABLE, 0o755);
  ensureDir(NGINX_ENABLED, 0o755);
  if (nginxLayoutMissing()) {
    writeFile(NGINX_SITES_INCLUDE, SITES_INCLUDE, 0o644);
    info(`nginx (họ RHEL): include ${NGINX_ENABLED}/*.conf qua ${NGINX_SITES_INCLUDE}.`);
    changed = true;
  }
  // nginx.conf gốc của một số bản (RHEL 8, vài bản Fedora) đánh dấu server mẫu
  // là 'default_server' -> trùng với server chặn Host lạ của napp ('duplicate
  // default server'). Bỏ cờ đó; server mẫu vẫn còn, chỉ không còn là mặc định.
  if (!execState.dryRun && existsSync(NGINX_MAIN_CONF)) {
    const text = readFileSync(NGINX_MAIN_CONF, "utf8");
    const next = text.replace(/^(\s*listen\s+[^;]*?)\s+default_server(\s*;)/gm, "$1$2");
    if (next !== text) {
      writeFile(`${NGINX_MAIN_CONF}.napp-bak`, text, 0o644);
      writeFile(NGINX_MAIN_CONF, next, 0o644);
      info(`nginx.conf: bỏ cờ 'default_server' của server mẫu (bản gốc: ${NGINX_MAIN_CONF}.napp-bak).`);
      changed = true;
    }
  }
  return changed;
}

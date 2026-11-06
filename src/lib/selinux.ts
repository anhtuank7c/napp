import { execCapture, runCmd, commandExists, state as execState } from "./exec";
import { info, ok, warn } from "./log";
import { isRhel, pkgInstall, packagesFor } from "./platform";

// --------------------------------------------------------------------------
// SELinux (họ RHEL bật Enforcing mặc định). napp GIỮ Enforcing và tự cấu hình
// đúng những gì nó cần, thay vì bảo người dùng tắt SELinux:
//
//  1. nginx proxy tới app ở 127.0.0.1:<cổng> -> boolean httpd_can_network_connect.
//     Thiếu nó: mọi site trả 502, error.log ghi "connect() ... (13: Permission denied)"
//     — trông y như app chết, trong khi app vẫn chạy bình thường.
//  2. nginx đọc file tĩnh/upload NGOÀI /var/www -> nhãn httpd_sys_content_t.
//     (/var/www đã có nhãn đó sẵn trong policy, file sinh ra bên trong kế thừa.)
//  3. Redis riêng (redis_t) ghi dữ liệu ở /var/lib/napp-redis, socket ở
//     /run/napp-redis, nghe cổng 6400-6499 -> nhãn redis_* cho thư mục + cổng.
//
// Mọi thao tác idempotent và chỉ chạy khi SELinux đang bật (Enforcing HOẶC
// Permissive — cấu hình sẵn để sau này bật Enforcing không gãy gì).
// --------------------------------------------------------------------------

export type SelinuxMode = "enforcing" | "permissive" | "disabled";

export function selinuxMode(): SelinuxMode {
  if (!commandExists("getenforce")) return "disabled";
  const m = execCapture("getenforce").stdout.trim().toLowerCase();
  return m === "enforcing" ? "enforcing" : m === "permissive" ? "permissive" : "disabled";
}

export const selinuxActive = (): boolean => isRhel() && selinuxMode() !== "disabled";

function ensureTools(): boolean {
  if (commandExists("semanage")) return true;
  if (execState.dryRun) return true;
  info("Cài công cụ quản lý nhãn SELinux (semanage)...");
  pkgInstall(packagesFor("selinux-tools"));
  return commandExists("semanage");
}

// --- 1. nginx -> app -------------------------------------------------------

export function nginxCanConnect(): boolean {
  return /-->\s*on/.test(execCapture("getsebool", ["httpd_can_network_connect"]).stdout);
}

/** Cho nginx (httpd_t) kết nối tới backend qua TCP. -P = bền qua reboot. */
export function ensureNginxCanConnect(): void {
  if (!selinuxActive() || nginxCanConnect()) return;
  info("SELinux: cho nginx kết nối tới app (setsebool -P httpd_can_network_connect 1 — mất ~10 giây)...");
  runCmd("setsebool", ["-P", "httpd_can_network_connect", "1"]);
  ok("SELinux: nginx đã được phép proxy tới app ở 127.0.0.1.");
}

// --- 2. nhãn file ----------------------------------------------------------

function localFcontexts(): string {
  return execCapture("semanage", ["fcontext", "-l", "-C"]).stdout;
}

/** Gán (bền vững) nhãn cho một cây thư mục rồi áp ngay bằng restorecon. */
export function labelTree(dir: string, type: string): void {
  if (!selinuxActive() || !ensureTools()) return;
  const spec = `${dir.replace(/\/+$/, "")}(/.*)?`;
  const existing = localFcontexts();
  if (!existing.split("\n").some((l) => l.startsWith(spec + " ") && l.includes(`:${type}:`))) {
    // -a lỗi nếu spec đã có (với nhãn khác) -> -m để sửa.
    if (runCmd("semanage", ["fcontext", "-a", "-t", type, spec], { silentFail: true }).code !== 0) {
      runCmd("semanage", ["fcontext", "-m", "-t", type, spec], { silentFail: true });
    }
  }
  runCmd("restorecon", ["-RF", dir], { silentFail: true });
}

/** nginx đọc được thư mục này (asset tĩnh / upload). Trong /var/www thì policy đã lo sẵn. */
export function labelForNginx(dir: string): void {
  if (!selinuxActive()) return;
  if (/^\/var\/www(\/|$)/.test(dir)) {
    runCmd("restorecon", ["-RF", dir], { silentFail: true }); // phòng file mang nhãn lạ (mv từ /tmp, /home)
    return;
  }
  labelTree(dir, "httpd_sys_content_t");
  info(`SELinux: gán nhãn httpd_sys_content_t cho ${dir} để nginx đọc được.`);
}

// --- 3. Redis riêng ----------------------------------------------------------

const REDIS_PORT_RANGE = "6400-6499";

function portRangeLabelled(): boolean {
  const out = execCapture("semanage", ["port", "-l", "-C"]).stdout;
  return out.split("\n").some((l) => /^redis_port_t\s+tcp\s/.test(l) && l.includes(REDIS_PORT_RANGE));
}

/**
 * redis-server chạy bằng systemd chuyển sang miền redis_t — chỉ được ghi vào
 * thư mục mang nhãn redis_* và chỉ nghe cổng mang nhãn redis_port_t. Gọi trước
 * khi khởi động một Redis riêng; rẻ khi đã cấu hình (chỉ đọc danh sách).
 */
export function ensureRedisInstanceSelinux(dirs: { conf: string; data: string; run: string }): void {
  if (!selinuxActive() || !ensureTools()) return;
  labelTree(dirs.data, "redis_var_lib_t");
  labelTree(dirs.run, "redis_var_run_t");
  labelTree(dirs.conf, "redis_conf_t");
  if (!portRangeLabelled()) {
    info(`SELinux: cho Redis riêng nghe cổng ${REDIS_PORT_RANGE} (redis_port_t)...`);
    if (runCmd("semanage", ["port", "-a", "-t", "redis_port_t", "-p", "tcp", REDIS_PORT_RANGE], { silentFail: true }).code !== 0) {
      runCmd("semanage", ["port", "-m", "-t", "redis_port_t", "-p", "tcp", REDIS_PORT_RANGE], { silentFail: true });
    }
  }
}

/** Một dòng tóm tắt cho 'napp check'. */
export function selinuxFindings(): { ok: boolean; message: string; fix?: () => void }[] {
  if (!isRhel()) return [];
  const mode = selinuxMode();
  if (mode === "disabled") return [{ ok: true, message: "SELinux: đang tắt" }];
  const out: { ok: boolean; message: string; fix?: () => void }[] = [{ ok: true, message: `SELinux: ${mode}` }];
  if (!nginxCanConnect()) {
    out.push({
      ok: false,
      message:
        "SELinux chặn nginx kết nối tới app (httpd_can_network_connect = off) — mọi site sẽ trả 502 với 'Permission denied' trong error.log dù app vẫn chạy.",
      fix: ensureNginxCanConnect,
    });
  }
  if (!commandExists("semanage")) {
    out.push({ ok: false, message: "Thiếu 'semanage' (policycoreutils-python-utils) — napp cần nó để gán nhãn SELinux cho Redis riêng và thư mục tĩnh.", fix: () => void ensureTools() });
  }
  if (mode === "permissive") warn("SELinux đang Permissive — napp vẫn cấu hình nhãn đầy đủ nên bật Enforcing lại được bất cứ lúc nào.");
  return out;
}

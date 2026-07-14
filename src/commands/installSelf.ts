import { existsSync, copyFileSync, chmodSync, unlinkSync, realpathSync } from "node:fs";
import { runCmd, requireRoot, ensureDir, writeFile } from "../lib/exec";
import { info, ok, warn } from "../lib/log";

const INSTALL_PATH = "/usr/local/bin/napp";
export const MOTD_PATH = "/etc/update-motd.d/99-napp";

// Banner giới thiệu napp, hiển thị mỗi khi đăng nhập SSH (Ubuntu update-motd.d).
// Phiên bản được lấy ĐỘNG qua `napp version` nên luôn khớp bản đang cài kể cả
// sau khi `napp update`. Màu bật mặc định, tắt khi có biến môi trường NO_COLOR.
function motdScript(): string {
  return `#!/bin/bash
# Managed by napp — banner giới thiệu khi đăng nhập SSH.
# TỰ SINH bởi 'napp install'; gỡ bằng 'napp uninstall'. ĐỪNG sửa tay.
command -v napp >/dev/null 2>&1 || exit 0

ver="$(napp version 2>/dev/null | awk '{print $NF}')"
[ -n "$ver" ] && ver="v$ver"

if [ -n "\${NO_COLOR:-}" ]; then
  c=""; b=""; d=""; r=""
else
  esc="$(printf '\\033')"
  c="\${esc}[36m"; b="\${esc}[1m"; d="\${esc}[2m"; r="\${esc}[0m"
fi

cat <<BANNER

  \${c}\${b}███╗   ██╗  █████╗  ██████╗  ██████╗\${r}   \${d}\${ver}\${r}
  \${c}\${b}████╗  ██║ ██╔══██╗ ██╔══██╗ ██╔══██╗\${r}
  \${c}\${b}██╔██╗ ██║ ███████║ ██████╔╝ ██████╔╝\${r}   Quản lý server Node.js/Bun đa ứng dụng
  \${c}\${b}██║╚██╗██║ ██╔══██║ ██╔═══╝  ██╔═══╝\${r}
  \${c}\${b}██║ ╚████║ ██║  ██║ ██║      ██║\${r}
  \${c}\${b}╚═╝  ╚═══╝ ╚═╝  ╚═╝ ╚═╝      ╚═╝\${r}

  \${b}Bắt đầu\${r}      sudo napp               \${d}# mở menu tương tác\${r}
  \${b}Ứng dụng\${r}     sudo napp app list      \${d}# xem / tạo / deploy app\${r}
  \${b}Môi trường\${r}   sudo napp check --fix   \${d}# kiểm tra & tự cài phụ thuộc\${r}
  \${d}Cập nhật: sudo napp update   ·   Gỡ banner: sudo napp uninstall\${r}

BANNER
`;
}

// Ghi (hoặc ghi đè) file banner MOTD. Tách riêng để 'napp update' có thể làm
// mới banner theo bản mới nhất mà không cần chạy lại 'napp install'.
export function writeMotdBanner(): void {
  writeFile(MOTD_PATH, motdScript(), 0o755);
}

export function cmdInstallSelf(): void {
  requireRoot();
  let src: string;
  try {
    src = realpathSync(process.argv[1] ?? "");
  } catch {
    src = process.argv[1] ?? "";
  }
  if (!existsSync(src)) {
    warn(`Không xác định được vị trí file thực thi hiện tại (${src}) — hãy chạy 'install' trực tiếp từ file napp.cjs đã tải về.`);
    return;
  }
  if (src === INSTALL_PATH) {
    ok(`napp đã được cài sẵn tại ${INSTALL_PATH}`);
  } else {
    ensureDir("/usr/local/bin", 0o755);
    copyFileSync(src, INSTALL_PATH);
    chmodSync(INSTALL_PATH, 0o755);
    ok(`Đã cài vào ${INSTALL_PATH}`);
  }
  writeMotdBanner();
  ok("Đã cài banner giới thiệu SSH (hiện mỗi lần đăng nhập).");
  info("Giờ bạn có thể chạy napp từ bất cứ đâu, ví dụ: sudo napp check --fix");
}

export function cmdUninstallSelf(): void {
  requireRoot();
  let removed = false;
  if (existsSync(INSTALL_PATH)) {
    unlinkSync(INSTALL_PATH);
    ok(`Đã gỡ ${INSTALL_PATH} (các app, systemd service và cấu hình nginx hiện có vẫn giữ nguyên)`);
    removed = true;
  }
  if (existsSync(MOTD_PATH)) {
    unlinkSync(MOTD_PATH);
    ok(`Đã gỡ banner chào mừng SSH (${MOTD_PATH})`);
    removed = true;
  }
  if (!removed) warn(`Không có gì để gỡ — ${INSTALL_PATH} không tồn tại.`);
}

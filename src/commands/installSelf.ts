import { existsSync, copyFileSync, chmodSync, unlinkSync, realpathSync } from "node:fs";
import { runCmd, requireRoot, ensureDir, writeFile } from "../lib/exec";
import { info, ok, warn } from "../lib/log";

const INSTALL_PATH = "/usr/local/bin/napp";
const MOTD_PATH = "/etc/update-motd.d/99-napp";

function motdScript(): string {
  return `#!/bin/bash
# Managed by napp — banner chào mừng khi đăng nhập SSH
if command -v napp >/dev/null 2>&1; then
  echo
  echo "napp — quản lý server Node.js đa ứng dụng. Gõ 'napp' để mở menu, 'napp app list' để xem các app."
  echo
fi
`;
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
  writeFile(MOTD_PATH, motdScript(), 0o755);
  ok("Đã cài banner chào mừng SSH.");
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

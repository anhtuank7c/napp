import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "./exec";

// --------------------------------------------------------------------------
// Log của app/service ('StandardOutput=append:/var/log/napp/<tên>.out.log') và
// nhật ký thao tác của napp KHÔNG tự nhỏ đi. Một app nói nhiều hay crash liên
// tục là đầy /var — rồi MariaDB/PostgreSQL dừng và MỌI app trên máy chết theo.
//
// copytruncate: systemd giữ file log MỞ suốt đời tiến trình; đổi tên file thì
// app vẫn ghi vào file cũ (đã đổi tên) mãi mãi. Chép rồi cắt về 0 là cách duy
// nhất không phải restart app. Đổi lại có thể mất vài dòng ghi đúng lúc cắt —
// chấp nhận được cho log ứng dụng.
//
// Hai khối RIÊNG, mẫu không trùng nhau: logrotate từ chối chạy nếu một file khớp
// hai khối ("duplicate log entry").
// --------------------------------------------------------------------------

export const LOGROTATE_PATH = "/etc/logrotate.d/napp";

export function renderLogrotate(): string {
  return `# Managed by napp — TỰ ĐỘNG SINH RA. Sửa tay sẽ bị ghi đè; đổi chính sách qua napp.
# Log stdout/stderr của app và background service.
/var/log/napp/*.out.log /var/log/napp/*.error.log {
    daily
    rotate 14
    maxsize 100M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}

# Nhật ký thao tác của napp (ai làm gì, lúc nào): giữ lâu hơn để điều tra sự cố.
/var/log/napp/audit.log {
    weekly
    rotate 52
    maxsize 50M
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
`;
}

export function logrotateInstalled(): boolean {
  return existsSync(LOGROTATE_PATH) && readFileSync(LOGROTATE_PATH, "utf8") === renderLogrotate();
}

/** Ghi /etc/logrotate.d/napp nếu thiếu hoặc khác bản hiện tại. */
export function ensureLogrotate(): void {
  if (logrotateInstalled()) return;
  writeFile(LOGROTATE_PATH, renderLogrotate(), 0o644);
}

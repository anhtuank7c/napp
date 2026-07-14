import type { AppRecord } from "../lib/state";

export interface AppSystemdOptions {
  // NODE_OPTIONS đặt cho app (ví dụ "--max-old-space-size=768"). Chỉ nên set cho
  // runtime node (V8); bun dùng JavaScriptCore, KHÔNG hiểu cờ heap của V8.
  nodeOptions?: string;
}

// Service systemd cho một app Node.js/Bun — chạy dưới user riêng của site,
// có hardening (NoNewPrivileges/ProtectSystem/ProtectHome), tự khởi động lại
// khi crash, và đọc biến môi trường từ file .env qua EnvironmentFile.
//
// Thứ tự biến môi trường CÓ CHỦ ĐÍCH:
//   - NODE_OPTIONS đặt TRƯỚC EnvironmentFile -> chỉ là MẶC ĐỊNH, .env của user
//     ghi đè được (systemd: directive sau thắng directive trước).
//   - NODE_ENV/PORT đặt SAU EnvironmentFile -> napp ÉP, .env không ghi đè được
//     (PORT do napp cấp phát, không cho app tự đổi).
export function renderAppSystemdService(app: AppRecord, execStart: string, opts: AppSystemdOptions = {}): string {
  const nodeOptionsLine = opts.nodeOptions ? `Environment=NODE_OPTIONS=${opts.nodeOptions}\n` : "";
  return `# Managed by napp — site: ${app.domain}
[Unit]
Description=napp application - ${app.domain}
After=network.target mariadb.service redis-server.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${app.user}
Group=${app.user}
WorkingDirectory=${app.webRoot}
${nodeOptionsLine}EnvironmentFile=-${app.webRoot}/.env
Environment=NODE_ENV=production
Environment=PORT=${app.port}
ExecStart=${execStart}
Restart=always
RestartSec=5
TimeoutStopSec=15

# --- Hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
# tmpfs (thay vì yes): vẫn GIẤU mọi thư mục home thật, nhưng cấp cho service một
# $HOME rỗng GHI ĐƯỢC (ephemeral) — thân thiện với runtime hay ghi cache vào
# home (bun ~/.bun, node ~/.npm) mà không lộ dữ liệu người dùng.
ProtectHome=tmpfs
PrivateTmp=yes
ReadWritePaths=${app.webRoot}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

# --- Giới hạn tài nguyên ---
LimitNOFILE=65535

# --- Log ---
StandardOutput=append:/var/log/napp/${app.domain}.out.log
StandardError=append:/var/log/napp/${app.domain}.error.log

[Install]
WantedBy=multi-user.target
`;
}

// ExecStart bọc qua bash -lc để chấp nhận BẤT KỲ lệnh khởi động nào người
// dùng khai báo (ví dụ "npm start", "node dist/server.js", "bun run src/index.ts",
// kể cả có biến môi trường PATH của nvm). Đánh đổi một lớp shell mỏng để lấy
// sự linh hoạt — chấp nhận được cho một service quản lý ứng dụng.
export function execStartLine(startCmd: string): string {
  const escaped = startCmd.replace(/'/g, `'\\''`);
  return `/bin/bash -lc '${escaped}'`;
}

// --- systemd timer cho backup định kỳ -----------------------------------
export function renderBackupService(scriptPath: string): string {
  return `# Managed by napp — backup định kỳ (database + source code)
[Unit]
Description=napp scheduled backup (database + source code)
After=network.target mariadb.service

[Service]
Type=oneshot
ExecStart=${scriptPath}
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
`;
}

export function renderBackupTimer(onCalendar: string): string {
  return `# Managed by napp — lịch chạy backup
[Unit]
Description=napp scheduled backup timer

[Timer]
OnCalendar=${onCalendar}
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
`;
}

// --- systemd timer cho đồng bộ dải IP Cloudflare vào nginx (real-IP) -----
// CHỈ cập nhật danh sách IP Cloudflare trong nginx để khôi phục IP client
// thật. KHÔNG đụng tới tường lửa — UFW mở 80/443 công khai, không phụ thuộc
// dải IP Cloudflare.
export function renderCloudflareSyncService(binPath: string): string {
  return `# Managed by napp — đồng bộ định kỳ dải IP Cloudflare vào nginx (real-IP)
[Unit]
Description=napp Cloudflare IP sync (nginx real-IP)

[Service]
Type=oneshot
ExecStart=${binPath} cloudflare sync --quiet
`;
}

// onCalendar: chuỗi OnCalendar của systemd (ví dụ "*-*-* 01:00:00" = 01:00 mỗi ngày).
export function renderCloudflareSyncTimer(onCalendar: string): string {
  return `# Managed by napp — lịch đồng bộ IP Cloudflare vào nginx (real-IP)
[Unit]
Description=napp Cloudflare IP sync timer

[Timer]
OnCalendar=${onCalendar}
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;
}

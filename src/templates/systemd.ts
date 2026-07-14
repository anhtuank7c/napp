import type { AppRecord } from "../lib/state";

// Service systemd cho một app Node.js/Bun — chạy dưới user riêng của site,
// có hardening (NoNewPrivileges/ProtectSystem/ProtectHome), tự khởi động lại
// khi crash, và đọc biến môi trường từ file .env qua EnvironmentFile.
export function renderAppSystemdService(app: AppRecord, execStart: string): string {
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
EnvironmentFile=-${app.webRoot}/.env
Environment=NODE_ENV=production
Environment=PORT=${app.port}
ExecStart=${execStart}
Restart=always
RestartSec=5
TimeoutStopSec=15

# --- Hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
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

export function renderCloudflareSyncTimer(): string {
  return `# Managed by napp — chạy hàng tuần (thứ 2, 03:00)
[Unit]
Description=napp Cloudflare IP sync timer

[Timer]
OnCalendar=Mon *-*-* 03:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;
}

import type { AppRecord, ServiceRecord } from "../lib/state";

export interface AppSystemdOptions {
  // NODE_OPTIONS đặt cho app (ví dụ "--max-old-space-size=768"). Chỉ nên set cho
  // runtime node (V8); bun dùng JavaScriptCore, KHÔNG hiểu cờ heap của V8.
  nodeOptions?: string;
}

// Thông tin định danh + môi trường để dựng MỘT unit systemd. Web app và
// background service dùng CHUNG renderer này (cùng hardening/restart/log), chỉ
// khác phần mô tả, thư mục, và các biến môi trường napp ÉP (forcedEnv).
interface UnitSpec {
  headerComment: string; // dòng "# Managed by napp — ..."
  description: string; // Description= trong [Unit]
  user: string;
  workDir: string;
  // Gốc mã nguồn được phép GHI. Thường trùng workDir; khác nhau khi app nằm
  // trong thư mục con của monorepo (workDir = <root>/apps/backend) — lúc đó
  // quyền ghi vẫn phải cấp cho CẢ gốc repo, vì thư mục ứng dụng ghi ra ngoài
  // phạm vi của mình là chuyện bình thường (uploads, cache, log dùng chung).
  // ProtectSystem=strict khiến mọi đường dẫn ngoài danh sách này thành chỉ-đọc,
  // và lỗi khi đó là EROFS lúc chạy chứ không phải lỗi lúc khởi động.
  rootDir?: string;
  // Đường dẫn GHI ĐƯỢC nằm ngoài rootDir — worker chạy bằng user của một app
  // web (`--run-as`) cần ghi vào thư mục của app đó (nén ảnh, dọn cache, sinh
  // thumbnail). Quyền Unix thôi không đủ: ProtectSystem=strict khiến mọi thứ
  // ngoài ReadWritePaths là chỉ-đọc, và lỗi là EROFS lúc chạy.
  extraWritePaths?: string[];
  logBase: string; // tiền tố file log: <logBase>.out.log / <logBase>.error.log
  execStart: string;
  nodeOptions?: string; // MẶC ĐỊNH (đặt trước EnvironmentFile, .env ghi đè được)
  forcedEnv: string[]; // napp ÉP (đặt sau EnvironmentFile, .env KHÔNG ghi đè được)
}

/** Thư mục làm việc thật: gốc repo, hoặc thư mục con khi là monorepo. */
export function unitWorkDir(root: string, appDir?: string): string {
  const sub = (appDir ?? "").trim().replace(/^\/+|\/+$/g, "");
  return sub ? `${root}/${sub}` : root;
}

// Renderer nền dùng chung. Thứ tự biến môi trường CÓ CHỦ ĐÍCH:
//   - NODE_OPTIONS đặt TRƯỚC EnvironmentFile -> chỉ là MẶC ĐỊNH, .env ghi đè được
//     (systemd: directive sau thắng directive trước).
//   - forcedEnv (NODE_ENV/PORT...) đặt SAU EnvironmentFile -> napp ÉP, .env không
//     ghi đè được (PORT do napp cấp phát, không cho tự đổi).
function renderUnit(spec: UnitSpec): string {
  const nodeOptionsLine = spec.nodeOptions ? `Environment=NODE_OPTIONS=${spec.nodeOptions}\n` : "";
  const forcedEnvLines = spec.forcedEnv.map((e) => `Environment=${e}`).join("\n");
  // Nhiều đường dẫn cách nhau bằng dấu cách trên MỘT dòng ReadWritePaths. Bỏ
  // trùng để không lặp lại rootDir khi ai đó truyền đúng nó qua --write-dir.
  const writePaths = [...new Set([spec.rootDir ?? spec.workDir, ...(spec.extraWritePaths ?? [])])];
  return `${spec.headerComment}
[Unit]
Description=${spec.description}
After=network.target mariadb.service redis-server.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${spec.user}
Group=${spec.user}
WorkingDirectory=${spec.workDir}
${nodeOptionsLine}EnvironmentFile=-${spec.workDir}/.env
${forcedEnvLines}
ExecStart=${spec.execStart}
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
ReadWritePaths=${writePaths.join(" ")}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

# --- Giới hạn tài nguyên ---
LimitNOFILE=65535

# --- Log ---
StandardOutput=append:${spec.logBase}.out.log
StandardError=append:${spec.logBase}.error.log

[Install]
WantedBy=multi-user.target
`;
}

// Unit systemd cho một app WEB (Node.js/Bun) — chạy dưới user riêng của site,
// có hardening, tự khởi động lại khi crash, đọc .env qua EnvironmentFile. napp
// ÉP NODE_ENV=production và PORT (cổng nội bộ do napp cấp phát cho nginx proxy).
export function renderAppSystemdService(app: AppRecord, execStart: string, opts: AppSystemdOptions = {}): string {
  return renderUnit({
    headerComment: `# Managed by napp — site: ${app.domain}`,
    description: `napp application - ${app.domain}`,
    user: app.user,
    // Monorepo: chạy TỪ thư mục con chứa ứng dụng. Quan trọng vì Node phân giải
    // import trần bằng cách đi ngược lên từ file gọi, mà pnpm chỉ symlink gói
    // vào node_modules của package đó — chạy từ gốc repo thì một gói có thật
    // vẫn báo ERR_MODULE_NOT_FOUND. `.env` cũng nằm cạnh ứng dụng, không ở gốc.
    workDir: unitWorkDir(app.webRoot, app.appDir),
    rootDir: app.webRoot,
    logBase: `/var/log/napp/${app.domain}`,
    execStart,
    nodeOptions: opts.nodeOptions,
    forcedEnv: [`NODE_ENV=production`, `PORT=${app.port}`],
  });
}

// Unit systemd cho một BACKGROUND SERVICE (chạy ngầm, không domain/nginx). Giống
// app web về hardening/restart/log, nhưng: napp CHỈ ép NODE_ENV=production; PORT
// chỉ đặt khi service được tạo với --port (worker thuần không listen gì cả).
export function renderServiceSystemdService(svc: ServiceRecord, execStart: string, opts: AppSystemdOptions = {}): string {
  const forcedEnv = [`NODE_ENV=production`];
  if (svc.port !== undefined) forcedEnv.push(`PORT=${svc.port}`);
  return renderUnit({
    headerComment: `# Managed by napp — service: ${svc.name}${svc.runAsUnit ? ` (chạy bằng user của '${svc.runAsUnit}')` : ""}`,
    description: `napp background service - ${svc.name}`,
    user: svc.user,
    workDir: unitWorkDir(svc.workDir, svc.appDir),
    rootDir: svc.workDir,
    extraWritePaths: svc.writePaths,
    logBase: `/var/log/napp/${svc.name}`,
    execStart,
    nodeOptions: opts.nodeOptions,
    forcedEnv,
  });
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

import { existsSync, readFileSync } from "node:fs";
import { execCapture, runCmd, requireRoot, commandExists, writeFile } from "../lib/exec";
import { info, ok, die } from "../lib/log";
import { fetchCloudflareIpRanges } from "../lib/cloudflare";
import { renderCloudflareRealIpSnippet, CLOUDFLARE_REALIP_CONF } from "../templates/nginx";
import { renderCloudflareSyncService, renderCloudflareSyncTimer } from "../templates/systemd";
import { timeToDailyOnCalendar } from "../lib/validate";
import { SYSTEMD_DIR } from "../lib/state";
import { writeManagedUnit } from "../lib/unitfile";
import { showTimer } from "../lib/timer";

const NAPP_BIN_PATH = "/usr/local/bin/napp";
export const CF_TIMER_NAME = "napp-cloudflare-sync";

export async function cmdCloudflareSync(opts: { quiet?: boolean } = {}): Promise<void> {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  const log = opts.quiet ? () => {} : info;

  log("Đang tải dải IP Cloudflare hiện tại...");
  const ranges = await fetchCloudflareIpRanges();
  writeFile(CLOUDFLARE_REALIP_CONF, renderCloudflareRealIpSnippet(ranges.ipv4, ranges.ipv6), 0o644);

  // Đảm bảo nginx.conf (khối http) có include conf.d/*.conf — hầu hết cài
  // đặt mặc định trên Ubuntu đã có sẵn dòng include này.
  const nginxMain = "/etc/nginx/nginx.conf";
  if (existsSync(nginxMain) && !readFileSync(nginxMain, "utf8").includes("include /etc/nginx/conf.d")) {
    console.log(
      "[CẢNH BÁO] /etc/nginx/nginx.conf có vẻ chưa include /etc/nginx/conf.d/*.conf trong khối http {}. " +
        "Hãy thêm dòng `include /etc/nginx/conf.d/*.conf;` thủ công rồi chạy lại."
    );
  }

  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) die(`Kiểm tra cấu hình nginx thất bại:\n${test.stderr}`);
  runCmd("systemctl", ["reload", "nginx"]);
  ok(`Đã đồng bộ ${ranges.ipv4.length + ranges.ipv6.length} dải IP Cloudflare vào ${CLOUDFLARE_REALIP_CONF} và reload nginx.`);
}

// Lên lịch tự động đồng bộ IP Cloudflare vào nginx (real-IP) qua systemd timer.
// Mặc định chạy hàng ngày lúc 01:00. Đây CHỈ là refresh danh sách IP cho nginx,
// KHÔNG đụng tới tường lửa.
export function cmdCloudflareSchedule(opts: { time: string }): void {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  const onCalendar = timeToDailyOnCalendar(opts.time);

  // ExecStart trỏ tới binary napp hiện tại -> napp làm chủ. Directive khác người
  // dùng sửa tay (log, Nice, User/Group) vẫn được giữ nguyên.
  writeManagedUnit(`${SYSTEMD_DIR}/${CF_TIMER_NAME}.service`, renderCloudflareSyncService(NAPP_BIN_PATH), { authoritative: ["ExecStart"] });
  writeFile(`${SYSTEMD_DIR}/${CF_TIMER_NAME}.timer`, renderCloudflareSyncTimer(onCalendar), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", `${CF_TIMER_NAME}.timer`]);
  ok(`Đã lên lịch tự động đồng bộ IP Cloudflare hàng ngày lúc ${opts.time} vào nginx real-IP.`);
  info(`Kiểm tra lịch chạy: systemctl list-timers ${CF_TIMER_NAME}.timer`);
}

export function cmdCloudflareUnschedule(): void {
  requireRoot();
  runCmd("systemctl", ["disable", "--now", `${CF_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${CF_TIMER_NAME}.service`, `${SYSTEMD_DIR}/${CF_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"]);
  ok("Đã gỡ lịch tự động đồng bộ IP Cloudflare.");
}

export function cmdCloudflareScheduleShow(): void {
  showTimer("Lịch đồng bộ IP Cloudflare", CF_TIMER_NAME, "sudo napp cloudflare schedule enable --time 01:00");
}

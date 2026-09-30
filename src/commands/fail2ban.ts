import { runCmd, requireRoot, commandExists, writeFile, execCapture } from "../lib/exec";
import { info, ok, die } from "../lib/log";
import {
  renderJailLocal,
  renderNappRatelimitFilter,
  renderNappScannerFilter,
  FAIL2BAN_JAIL_PATH,
  FAIL2BAN_NAPP_FILTER_PATH,
  FAIL2BAN_SCANNER_FILTER_PATH,
} from "../templates/fail2ban";
import { NGINX_SCANNER_LOG } from "../templates/nginx";

function detectSshPortForF2b(): number {
  const res = execCapture("bash", [
    "-lc",
    "grep -h -riE '^\\s*Port\\s+[0-9]+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tail -1 | grep -oE '[0-9]+'",
  ]);
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 22;
}

export function cmdFail2banSetup(opts: { sshPort?: number }): void {
  requireRoot();
  if (!commandExists("fail2ban-client")) {
    die("fail2ban chưa được cài. Chạy 'napp check --fix' trước.");
  }
  const sshPort = opts.sshPort ?? detectSshPortForF2b();
  info(`Áp cấu hình fail2ban (cổng SSH: ${sshPort})...`);

  writeFile(FAIL2BAN_NAPP_FILTER_PATH, renderNappRatelimitFilter(), 0o644);
  writeFile(FAIL2BAN_SCANNER_FILTER_PATH, renderNappScannerFilter(), 0o644);
  writeFile(FAIL2BAN_JAIL_PATH, renderJailLocal(sshPort), 0o644);

  // Tạo sẵn file log của jail 'napp-scanner' nếu chưa có.
  //
  // fail2ban chỉ CẢNH BÁO khi logpath không tồn tại rồi bỏ qua jail đó — không
  // báo lỗi, không dừng. Hệ quả: 'fail2ban-client status' vẫn liệt kê jail,
  // trông như đang chạy, mà thực tế không ai bị ban. Mà file này chỉ ra đời khi
  // nginx chặn request quét ĐẦU TIÊN, tức là thường muộn hơn lệnh này.
  // Quyền root:adm 640 giống hệt các log nginx khác trên Ubuntu.
  runCmd("touch", [NGINX_SCANNER_LOG]);
  runCmd("chown", ["root:adm", NGINX_SCANNER_LOG], { silentFail: true });
  runCmd("chmod", ["640", NGINX_SCANNER_LOG], { silentFail: true });

  runCmd("systemctl", ["enable", "fail2ban"]);
  runCmd("systemctl", ["restart", "fail2ban"]);
  ok("Đã áp cấu hình fail2ban: sshd, nginx-botsearch, nginx-http-auth, nginx-limit-req, napp-ratelimit, napp-scanner.");
  info(`• Jail 'napp-scanner' đọc ${NGINX_SCANNER_LOG} — mọi dòng trong đó đều là request quét đã bị nginx chặn, nên ban rất chặt (3 lần / 10 phút -> cấm 1 ngày) mà không sợ ban nhầm.`);
  info("• Các jail nginx nay ghi đè 'backend = auto': backend systemd ở [DEFAULT] khiến fail2ban BỎ QUA logpath và đi đọc journal — nginx ghi log ra file nên các jail đó trước đây không thấy gì để đọc.");
  info("• Chưa bật chặn quét lỗ hổng ở nginx? Chạy: napp nginx scan-block enable");
}

export function cmdFail2banStatus(): void {
  runCmd("fail2ban-client", ["status"]);
}

export function cmdFail2banUnban(jail: string, ip: string): void {
  requireRoot();
  runCmd("fail2ban-client", ["set", jail, "unbanip", ip]);
}

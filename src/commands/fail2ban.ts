import { runCmd, requireRoot, commandExists, writeFile, execCapture } from "../lib/exec";
import { info, ok, die } from "../lib/log";
import { renderJailLocal, renderNappRatelimitFilter, FAIL2BAN_JAIL_PATH, FAIL2BAN_NAPP_FILTER_PATH } from "../templates/fail2ban";

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
  writeFile(FAIL2BAN_JAIL_PATH, renderJailLocal(sshPort), 0o644);

  runCmd("systemctl", ["enable", "fail2ban"]);
  runCmd("systemctl", ["restart", "fail2ban"]);
  ok("Đã áp cấu hình fail2ban: sshd, nginx-botsearch, nginx-http-auth, nginx-limit-req, napp-ratelimit.");
}

export function cmdFail2banStatus(): void {
  runCmd("fail2ban-client", ["status"]);
}

export function cmdFail2banUnban(jail: string, ip: string): void {
  requireRoot();
  runCmd("fail2ban-client", ["set", jail, "unbanip", ip]);
}

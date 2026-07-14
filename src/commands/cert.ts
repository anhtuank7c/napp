import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { validateDomain } from "../lib/validate";
import { info, ok, die } from "../lib/log";
import { requireApp } from "../lib/state";

function requireCertbot(): void {
  if (!commandExists("certbot")) {
    die("certbot chưa được cài. Chạy 'napp check --fix' trước, hoặc: apt install certbot python3-certbot-nginx");
  }
}

export function cmdCertList(): void {
  requireCertbot();
  runCmd("certbot", ["certificates"]);
}

export function cmdCertStatus(domain?: string): void {
  requireCertbot();
  if (domain) {
    validateDomain(domain);
    runCmd("certbot", ["certificates", "--cert-name", domain]);
  } else {
    runCmd("certbot", ["certificates"]);
  }
}

export interface CertIssueOptions {
  noWww: boolean;
  extra: string[]; // domain phụ khác cần đưa vào cùng chứng chỉ
}

export function cmdCertIssue(domain: string, opts: CertIssueOptions): void {
  requireRoot();
  validateDomain(domain);
  requireApp(domain); // đảm bảo nginx vhost đã tồn tại (certbot cần sửa nó)
  requireCertbot();

  const args = ["--nginx", "-d", domain];
  if (!opts.noWww) args.push("-d", `www.${domain}`);
  for (const e of opts.extra) {
    validateDomain(e);
    args.push("-d", e);
  }

  info(`Đang phát hành chứng chỉ SSL cho ${domain} (certbot sẽ tự cập nhật nginx)...`);
  runCmd("certbot", args);
  ok("Hoàn tất. certbot đã cài chứng chỉ và tự lên lịch gia hạn (systemd timer certbot.timer).");
}

export interface CertRenewOptions {
  force: boolean;
}

export function cmdCertRenew(domain: string | undefined, opts: CertRenewOptions): void {
  requireRoot();
  requireCertbot();
  const args = ["renew"];
  if (domain) {
    validateDomain(domain);
    args.push("--cert-name", domain);
  }
  if (opts.force) args.push("--force-renewal");

  info(domain ? `Đang gia hạn chứng chỉ cho ${domain}...` : "Đang gia hạn tất cả chứng chỉ sắp hết hạn...");
  runCmd("certbot", args);
  ok("Hoàn tất gia hạn.");
}

export async function cmdCertRevoke(domain: string, opts: { yes: boolean }): Promise<void> {
  requireRoot();
  validateDomain(domain);
  requireCertbot();

  if (!opts.yes) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(
      `Thao tác này sẽ THU HỒI và XOÁ chứng chỉ của '${domain}'. Website sẽ mất HTTPS hợp lệ cho tới khi phát hành lại.\nTiếp tục? [y/N] `
    );
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  runCmd("certbot", ["revoke", "--cert-name", domain, "--delete-after-revoke", "--non-interactive"]);
  ok(`Đã thu hồi và xoá chứng chỉ của ${domain}.`);
}

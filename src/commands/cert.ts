import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { validateDomain } from "../lib/validate";
import { info, ok, die } from "../lib/log";
import { requireApp, getAcmeEmail, setAcmeEmail } from "../lib/state";

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
  email?: string; // email đăng ký Let's Encrypt (không có -> dùng email đã nhớ trong state)
  registerWithoutEmail?: boolean; // đăng ký KHÔNG email (--register-unsafely-without-email)
  redirect?: boolean; // mặc định true: tự thêm chuyển hướng HTTP -> HTTPS trong nginx
}

function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
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

  // CHẠY KHÔNG TƯƠNG TÁC để không bị treo ở prompt email/agree-tos của certbot.
  args.push("--non-interactive", "--agree-tos");

  const email = opts.email ?? getAcmeEmail();
  if (email) {
    if (!looksLikeEmail(email)) die(`Email không hợp lệ: '${email}'`);
    args.push("--email", email);
  } else if (opts.registerWithoutEmail) {
    args.push("--register-unsafely-without-email");
  } else {
    die(
      "Cần email cho Let's Encrypt (để nhận cảnh báo hết hạn/bảo mật). Truyền --email <email>,\n" +
        "  hoặc --no-email để đăng ký KHÔNG email (không khuyến nghị). Ví dụ:\n" +
        `    sudo napp cert issue ${domain} --email ban@example.com`
    );
  }

  // certbot --nginx: --redirect tự thêm khối chuyển HTTP->HTTPS; --no-redirect giữ nguyên.
  args.push(opts.redirect === false ? "--no-redirect" : "--redirect");

  info(`Đang phát hành chứng chỉ SSL cho ${domain} (certbot sẽ tự cập nhật nginx)...`);
  runCmd("certbot", args);
  if (email) setAcmeEmail(email); // nhớ email cho các lần phát hành sau
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

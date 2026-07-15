import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { validateDomain } from "../lib/validate";
import { info, ok, warn, die } from "../lib/log";
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

// Domain có bản ghi A hoặc AAAA công khai không? (NXDOMAIN/ENODATA -> false).
// Ta CHỈ kiểm tra "có phân giải" chứ KHÔNG so IP với server: domain bật proxy
// Cloudflare sẽ phân giải ra IP của Cloudflare mà vẫn cấp SSL được (HTTP-01 đi
// qua edge về origin).
async function domainResolves(domain: string): Promise<boolean> {
  const { resolve4, resolve6 } = await import("node:dns/promises");
  const has4 = await resolve4(domain).then((a) => a.length > 0).catch(() => false);
  if (has4) return true;
  return await resolve6(domain).then((a) => a.length > 0).catch(() => false);
}

export async function cmdCertIssue(domain: string, opts: CertIssueOptions): Promise<void> {
  requireRoot();
  validateDomain(domain);
  requireApp(domain); // đảm bảo nginx vhost đã tồn tại (certbot cần sửa nó)
  requireCertbot();

  // Ứng viên domain cho chứng chỉ.
  const candidates = [domain];
  if (!opts.noWww) candidates.push(`www.${domain}`);
  for (const e of opts.extra) {
    validateDomain(e);
    candidates.push(e);
  }

  // TIỀN KIỂM DNS: certbot cấp MỘT chứng chỉ cho tất cả -d; chỉ một domain chưa
  // có DNS (ví dụ www chưa trỏ) là HỎNG CẢ chứng chỉ. Nên ta loại domain chưa
  // phân giải (kèm cảnh báo) để phần còn lại vẫn cấp được.
  info("Đang kiểm tra DNS của các domain...");
  const resolvable: string[] = [];
  for (const d of candidates) {
    if (await domainResolves(d)) {
      resolvable.push(d);
    } else {
      warn(`'${d}' chưa có bản ghi DNS (A/AAAA) — BỎ khỏi chứng chỉ lần này. Trỏ DNS cho nó rồi chạy lại để bao gồm.`);
    }
  }
  if (!resolvable.includes(domain)) {
    die(
      `Domain chính '${domain}' chưa phân giải DNS — không thể phát hành chứng chỉ.\n` +
        `  Hãy trỏ bản ghi A của '${domain}' về server này (hoặc bật proxy Cloudflare), đợi DNS lan truyền, rồi chạy lại.`
    );
  }

  const args = ["--nginx"];
  for (const d of resolvable) args.push("-d", d);

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

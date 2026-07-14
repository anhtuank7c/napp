import { execCapture, runCmd, requireRoot, writeFile } from "../lib/exec";
import { validateDomain } from "../lib/validate";
import { info, ok, die, warn } from "../lib/log";
import { requireApp, upsertApp, NGINX_AVAILABLE, NGINX_ENABLED } from "../lib/state";
import { renderAppNginxConf } from "../templates/nginx";
import { ipv6Available } from "../lib/network";

function regenerateNginxConf(domain: string): void {
  const app = requireApp(domain);
  const ngxConf = `${NGINX_AVAILABLE}/${domain}.conf`;
  writeFile(ngxConf, renderAppNginxConf(app, { ipv6: ipv6Available() }), 0o644);
  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) die(`Kiểm tra cấu hình nginx thất bại:\n${test.stderr}`);
  runCmd("systemctl", ["reload", "nginx"]);
}

export function cmdDomainAdd(appDomain: string, alias: string): void {
  requireRoot();
  validateDomain(appDomain);
  validateDomain(alias);
  const app = requireApp(appDomain);
  if (app.aliasDomains.includes(alias)) {
    warn(`Domain '${alias}' đã được gắn với app '${appDomain}' từ trước.`);
    return;
  }
  app.aliasDomains.push(alias);
  app.updatedAt = new Date().toISOString();
  upsertApp(app);
  regenerateNginxConf(appDomain);
  ok(`Đã thêm domain phụ '${alias}' -> app '${appDomain}'.`);
  info(`Nhớ trỏ DNS A của '${alias}' về server này, rồi chạy: napp cert issue ${appDomain} --extra ${alias}`);
}

export function cmdDomainRemove(appDomain: string, alias: string): void {
  requireRoot();
  validateDomain(appDomain);
  const app = requireApp(appDomain);
  if (!app.aliasDomains.includes(alias)) {
    die(`Domain '${alias}' không thuộc app '${appDomain}'.`);
  }
  app.aliasDomains = app.aliasDomains.filter((d) => d !== alias);
  app.updatedAt = new Date().toISOString();
  upsertApp(app);
  regenerateNginxConf(appDomain);
  ok(`Đã gỡ domain phụ '${alias}' khỏi app '${appDomain}'.`);
}

export function cmdDomainList(appDomain: string): void {
  validateDomain(appDomain);
  const app = requireApp(appDomain);
  console.log(`${app.domain} (chính), www.${app.domain}${app.aliasDomains.length ? ", " + app.aliasDomains.join(", ") : ""}`);
}

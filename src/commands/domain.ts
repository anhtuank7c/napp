import { existsSync, readFileSync } from "node:fs";
import { execCapture, runCmd, requireRoot, writeFile, ensureDir } from "../lib/exec";
import { validateDomain } from "../lib/validate";
import { info, ok, die, warn } from "../lib/log";
import { requireApp, upsertApp, NGINX_AVAILABLE, NGINX_ENABLED } from "../lib/state";
import { renderAppNginxConf, renderAppLocationsConf, appLocationsPath, NGINX_LOCATIONS_DIR } from "../templates/nginx";
import { ipv6Available } from "../lib/network";

function regenerateNginxConf(domain: string): void {
  const app = requireApp(domain);
  const ngxConf = `${NGINX_AVAILABLE}/${domain}.conf`;

  // Vhost `include` file location của app. Ghi nó TRƯỚC, và ghi kể cả khi app
  // không bật tuỳ chọn nào: nginx TỪ CHỐI KHỞI ĐỘNG nếu include trỏ vào file
  // không tồn tại, nên với app tạo bằng bản napp cũ (chưa có file này) thì
  // regenerate mà thiếu bước này sẽ làm sập nginx của TOÀN MÁY, không riêng site.
  ensureDir(NGINX_LOCATIONS_DIR, 0o755);
  writeFile(appLocationsPath(domain), renderAppLocationsConf(app), 0o644);

  // Sao lưu để hoàn tác được: đây là ghi đè TOÀN BỘ vhost.
  const bak = `${ngxConf}.napp-bak`;
  const had = existsSync(ngxConf);
  const hadSsl = had && /ssl_certificate\s/.test(readFileSync(ngxConf, "utf8"));
  if (had) runCmd("cp", ["-a", ngxConf, bak]);

  writeFile(ngxConf, renderAppNginxConf(app, { ipv6: ipv6Available() }), 0o644);
  const test = execCapture("nginx", ["-t"]);
  if (test.code !== 0) {
    if (had) runCmd("cp", ["-a", bak, ngxConf], { silentFail: true });
    runCmd("rm", ["-f", bak], { silentFail: true });
    die(`Kiểm tra cấu hình nginx thất bại — ĐÃ HOÀN TÁC vhost:\n${test.stderr}`);
  }
  runCmd("systemctl", ["reload", "nginx"]);
  runCmd("rm", ["-f", bak], { silentFail: true });

  // Cảnh báo, không im lặng: render lại vhost XOÁ khối SSL mà certbot đã chèn
  // vào chính file này. Site vừa còn HTTPS bây giờ chỉ còn HTTP, và điều đó
  // không hiện ra ở đâu cho tới khi có người truy cập bằng https://.
  if (hadSsl) {
    warn(
      `Vhost vừa được render lại nên khối SSL do certbot chèn ĐÃ MẤT — site hiện chỉ còn HTTP.\n` +
        `  Cấp lại ngay để khôi phục HTTPS:  napp cert issue ${domain}` +
        (app.aliasDomains.length ? ` --extra ${app.aliasDomains.join(" --extra ")}` : "")
    );
  }
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

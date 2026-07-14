import { execCapture, runCmd, requireRoot, commandExists, writeFile } from "../lib/exec";
import { info, ok, die } from "../lib/log";
import { fetchCloudflareIpRanges } from "../lib/cloudflare";
import { renderCloudflareRealIpSnippet, CLOUDFLARE_REALIP_CONF } from "../templates/nginx";

export async function cmdCloudflareSync(opts: { quiet?: boolean } = {}): Promise<void> {
  requireRoot();
  if (!commandExists("nginx")) die("nginx chưa được cài. Chạy 'napp check --fix' trước.");
  const log = opts.quiet ? () => {} : info;

  log("Đang tải dải IP Cloudflare hiện tại...");
  const ranges = await fetchCloudflareIpRanges();
  writeFile(CLOUDFLARE_REALIP_CONF, renderCloudflareRealIpSnippet(ranges.ipv4, ranges.ipv6), 0o644);

  // Đảm bảo nginx.conf (khối http) có include conf.d/*.conf — hầu hết cài
  // đặt mặc định trên Ubuntu đã có sẵn dòng include này.
  const nginxConf = execCapture("bash", ["-lc", "grep -c 'include /etc/nginx/conf.d' /etc/nginx/nginx.conf || true"]).stdout.trim();
  if (nginxConf === "0") {
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

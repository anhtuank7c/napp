import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execCapture, runCmd, requireRoot, commandExists } from "../lib/exec";
import { info, ok, warn, die, section } from "../lib/log";
import { fetchCloudflareIpRanges } from "../lib/cloudflare";
import { ipv6Available } from "../lib/network";

// Cố dò cổng SSH thực tế đang cấu hình để KHÔNG khoá chính mình ra ngoài khi
// bật UFW. Ưu tiên /etc/ssh/sshd_config.d/*.conf (override mới hơn), sau đó
// /etc/ssh/sshd_config. Mặc định 22 nếu không tìm thấy khai báo tường minh.
function detectSshPort(): number {
  const candidates: string[] = ["/etc/ssh/sshd_config"];
  const dropInDir = "/etc/ssh/sshd_config.d";
  if (existsSync(dropInDir)) {
    for (const f of readdirSync(dropInDir)) candidates.push(`${dropInDir}/${f}`);
  }
  let port = 22;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const m = content.match(/^\s*Port\s+(\d+)/m);
    if (m) port = parseInt(m[1]!, 10);
  }
  return port;
}

export interface FirewallSyncOptions {
  sshPort?: number;
  // MẶC ĐỊNH false: mở 80/443 cho mọi IP. Việc lấy IP client thật (khi qua
  // Cloudflare proxy) do nginx đảm nhiệm qua `napp cloudflare apply` — KHÔNG
  // liên quan tới tường lửa. Đặt true (opt-in, nâng cao) nếu muốn khoá origin
  // chỉ nhận traffic từ dải IP Cloudflare (chống bypass thẳng vào origin IP).
  restrictToCloudflare: boolean;
  extraPorts: number[]; // các cổng bổ sung người dùng muốn mở công khai (hiếm khi cần)
  yes: boolean;
  quiet?: boolean;
}

export async function cmdFirewallSync(opts: FirewallSyncOptions): Promise<void> {
  requireRoot();
  if (!commandExists("ufw")) {
    die("UFW chưa được cài. Chạy 'napp check --fix' trước.");
  }
  const log = opts.quiet ? () => {} : info;
  const sshPort = opts.sshPort ?? detectSshPort();
  section("Đồng bộ tường lửa (UFW)");
  log(`Phát hiện cổng SSH hiện tại: ${sshPort}`);

  if (!opts.yes && !opts.quiet) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    warn(
      "AN TOÀN: hãy giữ một phiên SSH/console THỨ HAI đang mở song song trước khi tiếp tục — " +
        "nếu cổng SSH bị dò sai hoặc rule bị cấu hình nhầm, phiên hiện tại có thể bị khoá ngay lập tức."
    );
    const ans = await rl.question(
      `Sẽ cấu hình UFW: deny incoming mặc định, allow outgoing, allow SSH cổng ${sshPort}, ` +
        `${opts.restrictToCloudflare ? "allow 80/443 CHỈ từ IP Cloudflare" : "allow 80/443 cho mọi người"}.\n` +
        `Tiếp tục? [y/N] `
    );
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  // Xoá các rule "Cloudflare"/"napp" cũ trước khi thêm lại (idempotent) —
  // tránh rule chồng chất qua nhiều lần chạy `napp firewall apply`.
  const statusNumbered = execCapture("ufw", ["status", "numbered"]).stdout;
  const oldRuleNumbers = statusNumbered
    .split("\n")
    .filter((l) => /napp/i.test(l))
    .map((l) => l.match(/^\[\s*(\d+)\]/)?.[1])
    .filter((n): n is string => !!n)
    .map((n) => parseInt(n, 10))
    .sort((a, b) => b - a); // xoá từ số lớn xuống để không lệch chỉ số
  for (const n of oldRuleNumbers) {
    runCmd("bash", ["-lc", `yes | ufw delete ${n} >/dev/null 2>&1 || true`], { silentFail: true });
  }

  runCmd("ufw", ["default", "deny", "incoming"]);
  runCmd("ufw", ["default", "allow", "outgoing"]);
  runCmd("ufw", ["allow", `${sshPort}/tcp`, "comment", "napp: SSH"]);

  if (opts.restrictToCloudflare) {
    log("Đang tải dải IP Cloudflare hiện tại...");
    const ranges = await fetchCloudflareIpRanges();
    const hasIpv6 = ipv6Available();
    const ips = hasIpv6 ? [...ranges.ipv4, ...ranges.ipv6] : ranges.ipv4;
    if (!hasIpv6) warn("Máy chủ không có ngăn xếp IPv6 — bỏ qua các dải IP Cloudflare IPv6, chỉ whitelist IPv4.");
    for (const ip of ips) {
      runCmd("ufw", ["allow", "from", ip, "to", "any", "port", "80,443", "proto", "tcp", "comment", "napp: Cloudflare"]);
    }
    ok(`(Nâng cao) Đã khoá origin: 80/443 CHỈ nhận từ ${ips.length} dải IP Cloudflare.`);
    warn(
      "Chế độ khoá origin này KHÔNG cần cho việc lấy IP client thật (đó là việc của nginx real-IP qua " +
        "`napp cloudflare apply`). Chỉ bật nếu muốn chống bypass thẳng vào origin IP, VÀ mọi domain đều bật proxy " +
        "(orange cloud) trên Cloudflare — domain nào không qua proxy sẽ bị chặn."
    );
  } else {
    runCmd("ufw", ["allow", "80,443/tcp", "comment", "napp: HTTP/HTTPS"]);
    log("80/443 mở cho mọi IP. IP client thật do nginx khôi phục qua `napp cloudflare apply` (real-IP từ header CF-Connecting-IP).");
  }

  for (const p of opts.extraPorts) {
    runCmd("ufw", ["allow", `${p}/tcp`, "comment", "napp: extra"]);
  }

  runCmd("bash", ["-lc", "yes | ufw enable"]);
  runCmd("ufw", ["reload"]);
  ok("UFW đã được đồng bộ và bật.");
}

export function cmdFirewallStatus(): void {
  runCmd("ufw", ["status", "verbose"]);
}

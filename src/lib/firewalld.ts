import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execCapture, runCmd, commandExists, writeFile, state as execState } from "./exec";
import { info, ok, warn, die, section } from "./log";
import { ask } from "./prompt";
import { fetchCloudflareIpRanges } from "./cloudflare";
import { ipv6Available } from "./network";
import { NAPP_ROOT } from "./state";
import type { FirewallSyncOptions } from "../commands/firewall";

// --------------------------------------------------------------------------
// firewalld (họ RHEL) — tương đương 'napp firewall apply' bằng UFW trên Ubuntu.
//
// Mọi thay đổi đi vào cấu hình --permanent rồi --reload (bền qua reboot, áp
// một lần). napp chỉ đụng tới những gì NÓ thêm vào: SSH, 80/443 (dịch vụ
// http/https HOẶC rich rule theo ipset Cloudflare), cổng --extra. Danh sách
// đó được ghi lại để lần chạy sau gỡ đúng phần của mình; dịch vụ người dùng
// tự mở (cockpit...) được giữ nguyên, chỉ được liệt kê ra để họ biết.
// --------------------------------------------------------------------------

const STATE_PATH = `${NAPP_ROOT}/firewalld.json`;
const IPSET4 = "napp-cloudflare4";
const IPSET6 = "napp-cloudflare6";

interface Managed {
  zone: string;
  sshPort?: number; // cổng SSH napp đã mở bằng --add-port (khác 22)
  extraPorts: number[];
}

function readManaged(): Managed | undefined {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as Managed;
  } catch {
    return undefined;
  }
}

function fw(args: string[], silentFail = false): { code: number; out: string } {
  const r = runCmd("firewall-cmd", args, { silentFail });
  return { code: r.code, out: r.stdout.trim() };
}

function q(args: string[]): string {
  return execCapture("firewall-cmd", args).stdout.trim();
}

/** Gỡ mọi thứ napp đã thêm ở lần trước (permanent). Không lỗi nếu đã không còn. */
function removePrevious(zone: string, prev: Managed | undefined): void {
  const z = `--zone=${prev?.zone ?? zone}`;
  for (const rule of q(["--permanent", z, "--list-rich-rules"]).split("\n")) {
    if (rule.includes(`ipset="${IPSET4}"`) || rule.includes(`ipset="${IPSET6}"`)) fw(["--permanent", z, `--remove-rich-rule=${rule}`], true);
  }
  const ipsets = q(["--permanent", "--get-ipsets"]).split(/\s+/);
  for (const s of [IPSET4, IPSET6]) if (ipsets.includes(s)) fw(["--permanent", `--delete-ipset=${s}`], true);
  for (const svc of ["http", "https"]) fw(["--permanent", z, `--remove-service=${svc}`], true);
  for (const p of prev?.extraPorts ?? []) fw(["--permanent", z, `--remove-port=${p}/tcp`], true);
}

function addIpset(name: string, family: "inet" | "inet6", entries: string[]): void {
  fw(["--permanent", `--new-ipset=${name}`, "--type=hash:net", `--option=family=${family}`]);
  if (execState.dryRun) return;
  const dir = mkdtempSync(`${tmpdir()}/napp-fw-`);
  try {
    const file = `${dir}/entries`;
    writeFileSync(file, entries.join("\n") + "\n", { mode: 0o600 });
    fw(["--permanent", `--ipset=${name}`, `--add-entries-from-file=${file}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function firewalldSync(opts: FirewallSyncOptions, detectedSshPort: number): Promise<void> {
  if (!commandExists("firewall-cmd")) die("firewalld chưa được cài. Chạy 'napp check --fix' trước.");
  const log = opts.quiet ? () => {} : info;
  const sshPort = opts.sshPort ?? detectedSshPort;
  section("Đồng bộ tường lửa (firewalld)");
  log(`Phát hiện cổng SSH hiện tại: ${sshPort}`);

  if (!opts.yes && !opts.quiet) {
    warn(
      "AN TOÀN: hãy giữ một phiên SSH/console THỨ HAI đang mở song song trước khi tiếp tục — " +
        "nếu cổng SSH bị dò sai, phiên hiện tại có thể bị khoá ngay khi firewalld nạp lại."
    );
    const ans = await ask(
      `Sẽ cấu hình firewalld (zone mặc định): mở SSH cổng ${sshPort}, ` +
        `${opts.restrictToCloudflare ? "80/443 CHỈ từ IP Cloudflare" : "80/443 cho mọi người"}; ` +
        `mọi cổng khác bị chặn (trừ những gì bạn đã tự mở).\nTiếp tục? [y/N] `
    );
    if (!/^y(es)?$/i.test(ans.trim())) {
      info("Đã huỷ.");
      return;
    }
  }

  runCmd("systemctl", ["enable", "--now", "firewalld"]);
  const zone = q(["--get-default-zone"]) || "public";
  const z = `--zone=${zone}`;
  const prev = readManaged();
  removePrevious(zone, prev);

  // SSH TRƯỚC mọi thứ khác — firewalld chỉ nạp lại ở cuối nên thứ tự không khoá
  // ai ra ngoài, nhưng thêm SSH đầu tiên để lỗi ở bước sau không bỏ quên nó.
  if (sshPort === 22) fw(["--permanent", z, "--add-service=ssh"]);
  else {
    fw(["--permanent", z, `--add-port=${sshPort}/tcp`]);
    if (prev?.sshPort && prev.sshPort !== sshPort) warn(`Cổng SSH cũ ${prev.sshPort}/tcp vẫn mở — gỡ khi chắc chắn không còn dùng: firewall-cmd --permanent --remove-port=${prev.sshPort}/tcp && firewall-cmd --reload`);
  }

  if (opts.restrictToCloudflare) {
    log("Đang tải dải IP Cloudflare hiện tại...");
    const ranges = await fetchCloudflareIpRanges();
    addIpset(IPSET4, "inet", ranges.ipv4);
    const v6 = ipv6Available();
    if (v6) addIpset(IPSET6, "inet6", ranges.ipv6);
    else warn("Máy chủ không có ngăn xếp IPv6 — chỉ whitelist dải IPv4 của Cloudflare.");
    for (const svc of ["http", "https"]) {
      fw(["--permanent", z, `--add-rich-rule=rule family="ipv4" source ipset="${IPSET4}" service name="${svc}" accept`]);
      if (v6) fw(["--permanent", z, `--add-rich-rule=rule family="ipv6" source ipset="${IPSET6}" service name="${svc}" accept`]);
    }
    ok(`(Nâng cao) Đã khoá origin: 80/443 CHỈ nhận từ ${ranges.ipv4.length + (v6 ? ranges.ipv6.length : 0)} dải IP Cloudflare (ipset ${IPSET4}${v6 ? `/${IPSET6}` : ""}).`);
    warn("Chỉ bật chế độ này khi MỌI domain đều bật proxy (orange cloud) trên Cloudflare — domain nào không qua proxy sẽ bị chặn.");
  } else {
    fw(["--permanent", z, "--add-service=http"]);
    fw(["--permanent", z, "--add-service=https"]);
    log("80/443 mở cho mọi IP. IP client thật do nginx khôi phục qua `napp cloudflare apply`.");
  }

  for (const p of opts.extraPorts) fw(["--permanent", z, `--add-port=${p}/tcp`]);
  fw(["--reload"]);

  writeFile(STATE_PATH, JSON.stringify({ zone, sshPort: sshPort === 22 ? undefined : sshPort, extraPorts: opts.extraPorts } satisfies Managed, null, 2) + "\n", 0o600);

  // Những gì KHÔNG phải của napp mà vẫn đang mở -> chỉ báo, không gỡ.
  const others = q([z, "--list-services"])
    .split(/\s+/)
    .filter((s) => s && !["ssh", "http", "https", "dhcpv6-client"].includes(s));
  const otherPorts = q([z, "--list-ports"])
    .split(/\s+/)
    .filter((p) => p && p !== `${sshPort}/tcp` && !opts.extraPorts.map((x) => `${x}/tcp`).includes(p));
  if (others.length || otherPorts.length) {
    warn(
      `Zone '${zone}' còn mở thêm (không do napp quản lý): ${[...others, ...otherPorts].join(", ")}.\n` +
        `  Không cần thì đóng lại, vd: firewall-cmd --permanent --remove-service=cockpit && firewall-cmd --reload`
    );
  }
  ok(`firewalld đã được đồng bộ (zone '${zone}').`);
}

export function firewalldActive(): boolean {
  return existsSync("/usr/bin/firewall-cmd") && execCapture("firewall-cmd", ["--state"]).stdout.trim() === "running";
}

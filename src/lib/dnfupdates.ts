import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execCapture, commandExists, runCmd, type RunResult } from "./exec";
import { warn } from "./log";
import type { PendingUpdate } from "./apt";

// --------------------------------------------------------------------------
// Trạng thái BẢN VÁ của họ RHEL qua dnf (dnf4 trên EL9, dnf5 trên Fedora/EL10).
//
// Tương đương lib/apt.ts:
//   - gói đang chờ      : 'dnf check-update' (mã 100 = có bản cập nhật)
//   - gói là bản vá BẢO MẬT: 'dnf updateinfo list --security' (errata/advisory
//     của distro: RHSA/ALSA/RLSA/FEDORA-...). CentOS Stream KHÔNG phát hành
//     errata -> danh sách bảo mật luôn rỗng, phải báo cho người dùng biết.
//   - cần reboot        : 'dnf needs-restarting -r'; không có plugin thì so
//     kernel đang chạy với kernel mới nhất đã cài.
// Không phải root: thêm -C (chỉ đọc cache có sẵn) — nếu không dnf sẽ tự tải
// metadata vào cache riêng của user, vừa chậm vừa không phản ánh máy.
// --------------------------------------------------------------------------

const ARCHES = "x86_64_v2|x86_64_v3|x86_64|aarch64|noarch|i686|ppc64le|s390x";
// NEVRA: name-[epoch:]version-release.arch
const NEVRA_RE = new RegExp(`^(.+)-(?:\\d+:)?[^-]+-[^-]+\\.(?:${ARCHES})$`);

function isRoot(): boolean {
  return !process.getuid || process.getuid() === 0;
}

function dnfQuery(args: string[]): RunResult {
  return execCapture("dnf", ["-q", ...(isRoot() ? [] : ["-C"]), ...args]);
}

export function hasDnf(): boolean {
  return commandExists("dnf");
}

/** CentOS Stream / distro không có errata -> không phân biệt được bản vá bảo mật. */
export function distroHasErrata(): boolean {
  try {
    return !/^ID="?centos"?$/m.test(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return true;
  }
}

/** Tên gói từ "openssl-libs.x86_64" hoặc NEVRA "openssl-libs-1:3.0.7-27.el9.x86_64". */
export function pkgNameFromNevra(token: string): string | undefined {
  return token.match(NEVRA_RE)?.[1];
}

/** Phân tích 'dnf check-update' (dnf4 và dnf5 cùng dạng: name.arch  version  repo). */
export function parseCheckUpdate(stdout: string): { pkg: string; newVersion: string; repo: string }[] {
  const out = new Map<string, { pkg: string; newVersion: string; repo: string }>();
  for (const line of stdout.split("\n")) {
    if (/^(Obsoleting|Security:|Last metadata)/i.test(line.trim())) {
      if (/^Obsoleting/i.test(line.trim())) break;
      continue;
    }
    const m = line.match(new RegExp(`^(\\S+)\\.(?:${ARCHES})\\s+(\\S+)\\s+(\\S+)\\s*$`));
    if (!m) continue;
    // Gói đa kiến trúc (x86_64 + i686) chỉ cần một dòng.
    if (!out.has(m[1]!)) out.set(m[1]!, { pkg: m[1]!, newVersion: m[2]!.replace(/^0:/, ""), repo: m[3]! });
  }
  return [...out.values()];
}

/** Tên gói có advisory BẢO MẬT đang chờ — đọc mọi token dạng NEVRA (dnf4 lẫn dnf5 đều in NEVRA). */
export function parseSecurityList(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split("\n")) {
    for (const tok of line.trim().split(/\s+/)) {
      const n = pkgNameFromNevra(tok);
      if (n) names.add(n);
    }
  }
  return names;
}

function installedVersions(pkgs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (pkgs.length === 0) return map;
  const res = execCapture("rpm", ["-q", "--qf", "%{NAME} %|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}\\n", ...pkgs]);
  for (const line of res.stdout.split("\n")) {
    const [name, ver] = line.trim().split(" ");
    if (name && ver && !/not installed/.test(line)) map.set(name, ver); // kernel nhiều bản: lấy dòng cuối
  }
  return map;
}

export function dnfPendingUpdates(): PendingUpdate[] {
  if (!hasDnf()) return [];
  const res = dnfQuery(["check-update"]);
  // 0 = không có gì, 100 = có bản cập nhật, khác = lỗi (thường là chưa có cache khi không phải root).
  if (res.code !== 100) {
    if (res.code !== 0) {
      const why = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
      warn(`dnf không đọc được danh sách cập nhật (${why || `mã ${res.code}`})${isRoot() ? "" : " — chạy lại bằng sudo"}. Kết quả dưới đây KHÔNG đầy đủ.`);
    }
    return [];
  }
  const pending = parseCheckUpdate(res.stdout);
  const security = parseSecurityList(dnfQuery(["updateinfo", "list", "--security"]).stdout);
  const current = installedVersions(pending.map((p) => p.pkg));
  return pending.map((p) => ({
    pkg: p.pkg,
    currentVersion: current.get(p.pkg) ?? "",
    newVersion: p.newVersion,
    origins: p.repo,
    security: security.has(p.pkg),
  }));
}

/** Tuổi metadata của dnf (giây) — lấy repomd.xml mới nhất trong cache dnf4/dnf5. */
export function dnfIndexAgeSeconds(): number | undefined {
  let newest = 0;
  for (const root of ["/var/cache/dnf", "/var/cache/libdnf5"]) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      try {
        newest = Math.max(newest, statSync(`${root}/${e}/repodata/repomd.xml`).mtimeMs);
      } catch {
        /* không phải thư mục kho */
      }
    }
  }
  return newest ? Math.floor((Date.now() - newest) / 1000) : undefined;
}

export function dnfRefresh(opts: { silentFail?: boolean } = {}): void {
  // Bắt output: dnf5 vẫn in "Metadata cache created." dù có -q.
  const res = execCapture("dnf", ["-q", "makecache", "--refresh"]);
  if (res.code !== 0) {
    const msg = `dnf makecache thất bại (mã ${res.code}): ${(res.stderr || res.stdout).trim().split("\n")[0] ?? ""}`;
    if (opts.silentFail) warn(msg);
    else throw new Error(msg);
  }
}

/** Nâng cấp đúng các gói chỉ định. rpm giữ file cấu hình đã sửa (bản mới thành *.rpmnew) — không hỏi gì. */
export function dnfUpgrade(pkgs: string[]): void {
  runCmd("dnf", ["-y", "upgrade", ...pkgs]);
}

// Gói "lõi" mà needs-restarting coi là phải reboot.
function runningKernelOutdated(): string | undefined {
  const running = execCapture("uname", ["-r"]).stdout.trim();
  // --last: mới cài nhất lên đầu, dạng "kernel-core-6.12.0-55.el10.x86_64  <ngày>"
  const res = execCapture("rpm", ["-q", "--last", "kernel-core"]);
  if (res.code !== 0 || !running) return undefined;
  const newest = res.stdout.split("\n")[0]?.trim().split(/\s+/)[0]?.replace(/^kernel-core-/, "");
  return newest && newest !== running ? newest : undefined;
}

export function dnfRebootRequired(): { required: boolean; packages: string[] } {
  const res = dnfQuery(["needs-restarting", "-r"]);
  // dnf4 (dnf-plugins-core) và dnf5: mã 1 + liệt kê "  * glibc" khi cần reboot.
  if (res.code === 0 || res.code === 1) {
    const out = `${res.stdout}\n${res.stderr}`;
    if (/Reboot is required|Reboot should not be necessary|No core libraries/i.test(out)) {
      const packages = [...out.matchAll(/^\s*\*\s+(\S+)/gm)].map((m) => m[1]!);
      return { required: res.code === 1 && /Reboot is required/i.test(out), packages };
    }
  }
  // Không có plugin needs-restarting: tự so kernel.
  const k = runningKernelOutdated();
  return k ? { required: true, packages: [`kernel-core ${k}`] } : { required: false, packages: [] };
}

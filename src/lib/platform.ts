import { existsSync, readFileSync } from "node:fs";
import { execCapture, commandExists, runCmd, whichAll, writeFile, type RunResult } from "./exec";
import { aptGet } from "./apt";
import { info, ok, warn, die } from "./log";

// --------------------------------------------------------------------------
// Nền tảng: napp chạy trên HAI họ distro.
//   - debian: Ubuntu 20.04–26.04, Debian 11–13       (apt, ufw)
//   - rhel  : RHEL, Rocky, AlmaLinux, Oracle Linux, CentOS Stream 9/10,
//             Fedora                                  (dnf, firewalld, SELinux)
// Mọi chỗ cần rẽ nhánh theo distro đi qua module này — không rải
// 'commandExists("apt-get")' khắp nơi.
// --------------------------------------------------------------------------

export type OsFamily = "debian" | "rhel" | "unknown";

export interface OsInfo {
  id: string; // ubuntu, debian, rhel, rocky, almalinux, ol, centos, fedora...
  idLike: string[];
  versionId: string; // "24.04", "9.4", "41"
  major: number;
  prettyName: string;
  family: OsFamily;
}

let cached: OsInfo | undefined;

export function parseOsRelease(raw: string): OsInfo {
  const kv: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]!] = m[2]!.trim().replace(/^"|"$/g, "");
  }
  const id = (kv.ID ?? "").toLowerCase();
  const idLike = (kv.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const all = [id, ...idLike];
  const family: OsFamily = all.some((x) => ["rhel", "fedora", "centos"].includes(x))
    ? "rhel"
    : all.some((x) => ["debian", "ubuntu"].includes(x))
      ? "debian"
      : "unknown";
  const versionId = kv.VERSION_ID ?? "";
  return { id, idLike, versionId, major: parseInt(versionId.split(".")[0] ?? "0", 10) || 0, prettyName: kv.PRETTY_NAME ?? (id || "không rõ"), family };
}

export function osInfo(): OsInfo {
  if (cached) return cached;
  let raw = "";
  try {
    raw = readFileSync("/etc/os-release", "utf8");
  } catch {
    /* không phải Linux chuẩn — để family = unknown */
  }
  cached = parseOsRelease(raw);
  return cached;
}

export const isRhel = (): boolean => osInfo().family === "rhel";
export const isDebian = (): boolean => osInfo().family === "debian";
export const isFedora = (): boolean => osInfo().id === "fedora";

const RHEL_CLONES = ["rhel", "rocky", "almalinux", "ol", "centos", "eurolinux", "navy", "circle"];

/** Distro này có nằm trong phạm vi napp đã kiểm thử không. */
export function osSupport(o: OsInfo = osInfo()): { ok: boolean; message: string } {
  if (o.id === "ubuntu") {
    return o.major >= 20 && o.major <= 26
      ? { ok: true, message: `Hệ điều hành: ${o.prettyName}` }
      : { ok: false, message: `Ubuntu ${o.versionId} nằm ngoài phạm vi đã kiểm thử (20.04 - 26.04 LTS)` };
  }
  if (o.id === "debian") {
    return o.major >= 11 ? { ok: true, message: `Hệ điều hành: ${o.prettyName}` } : { ok: false, message: `Debian ${o.versionId} quá cũ (cần 11+)` };
  }
  if (o.id === "fedora") {
    return o.major >= 40 ? { ok: true, message: `Hệ điều hành: ${o.prettyName}` } : { ok: false, message: `Fedora ${o.versionId} đã hết hỗ trợ (cần 40+)` };
  }
  if (o.family === "rhel") {
    if (o.major === 9 || o.major === 10) return { ok: true, message: `Hệ điều hành: ${o.prettyName}` };
    if (o.major === 8) return { ok: false, message: `${o.prettyName}: họ RHEL bản 8 chưa được hỗ trợ (cần bản 9 hoặc 10)` };
    const kind = RHEL_CLONES.includes(o.id) ? "phiên bản" : "distro";
    return { ok: false, message: `${o.prettyName}: ${kind} ngoài phạm vi đã kiểm thử (họ RHEL 9/10, Fedora 40+) — vẫn thử chạy được, có thể gặp lỗi` };
  }
  return { ok: false, message: `Hệ điều hành chưa được hỗ trợ: ${o.prettyName} (napp hỗ trợ Ubuntu/Debian và họ RHEL 9/10, Fedora)` };
}

// --------------------------------------------------------------------------
// Quản lý gói
// --------------------------------------------------------------------------

export type PkgManager = "apt" | "dnf";

export function pkgManager(): PkgManager | undefined {
  if (commandExists("apt-get")) return "apt";
  if (commandExists("dnf")) return "dnf";
  return undefined;
}

/** Gói đã cài thật (apt: "install ok installed", không tính gói chỉ còn file cấu hình). */
export function pkgInstalled(pkg: string): boolean {
  if (pkgManager() === "dnf") return execCapture("rpm", ["-q", "--quiet", pkg]).code === 0;
  const res = execCapture("dpkg-query", ["-W", "-f=${Status}", pkg]);
  return res.code === 0 && /install ok installed/.test(res.stdout);
}

/** 'dnf' không tương tác (-y) và không hỏi khoá GPG lần đầu bằng prompt (đã -y). */
export function dnf(args: string[], opts: { silentFail?: boolean } = {}): RunResult {
  return runCmd("dnf", ["-y", ...args], opts);
}

export function pkgInstall(pkgs: string[], opts: { refresh?: boolean } = {}): void {
  if (pkgs.length === 0) return;
  const pm = pkgManager();
  if (pm === "apt") {
    if (opts.refresh !== false) aptGet(["update"]);
    aptGet(["install", "-y", ...pkgs]);
    return;
  }
  if (pm === "dnf") {
    dnf(["install", ...pkgs]);
    return;
  }
  die("Không tìm thấy trình quản lý gói (apt-get / dnf) — napp chỉ hỗ trợ Ubuntu/Debian và họ RHEL.");
}

/** Gỡ gói. purge (apt) xoá luôn cấu hình; dnf không có khái niệm đó — caller tự xoá thư mục dữ liệu. */
export function pkgRemove(pkgs: string[], purge: boolean): void {
  const present = pkgs.filter((p) => (pkgManager() === "dnf" ? pkgInstalled(p) : execCapture("dpkg-query", ["-W", "-f=${Status}", p]).code === 0));
  if (present.length === 0) return;
  if (pkgManager() === "dnf") {
    dnf(["remove", ...present]);
    return;
  }
  aptGet([purge ? "purge" : "remove", "-y", ...present]);
  if (purge) aptGet(["autoremove", "--purge", "-y"], { silentFail: true });
}

/** Kho có gói tên này không (dnf). Dùng để chọn redis/valkey. */
export function dnfHasPackage(pkg: string): boolean {
  return execCapture("dnf", ["-q", "list", "--available", "--installed", pkg]).code === 0;
}

/**
 * EPEL — certbot, fail2ban... không có trong kho gốc của RHEL. Fedora đã có
 * sẵn tất cả nên bỏ qua. CRB (CodeReady Builder) cũng bật vì vài gói EPEL phụ
 * thuộc vào nó; bật hỏng thì chỉ cảnh báo.
 */
export function ensureEpel(): void {
  const o = osInfo();
  if (o.family !== "rhel" || o.id === "fedora") return;
  // Hỏi thẳng kho đã bật chưa — tên gói bật EPEL khác nhau giữa các distro
  // (epel-release, oracle-epel-release-elN, gói release riêng của AlmaLinux 10...).
  if (/^epel\b/m.test(execCapture("dnf", ["repolist", "--enabled", "-q"]).stdout)) return;
  info("Đang bật kho EPEL (certbot, fail2ban... nằm ở đây)...");
  if (o.id === "rhel") {
    runCmd("subscription-manager", ["repos", "--enable", `codeready-builder-for-rhel-${o.major}-${process.arch === "arm64" ? "aarch64" : "x86_64"}-rpms`], { silentFail: true });
    dnf(["install", `https://dl.fedoraproject.org/pub/epel/epel-release-latest-${o.major}.noarch.rpm`]);
  } else if (o.id === "ol") {
    dnf(["install", `oracle-epel-release-el${o.major}`]);
  } else {
    dnf(["install", "dnf-plugins-core"], { silentFail: true });
    if (runCmd("dnf", ["config-manager", "--set-enabled", "crb"], { silentFail: true }).code !== 0) {
      warn("Không bật được kho CRB — đa số gói EPEL napp dùng vẫn cài được.");
    }
    dnf(["install", "epel-release"]);
  }
  ok("Đã bật EPEL.");
}

/** Lệnh cài Node.js LTS qua NodeSource (deb hoặc rpm). */
export function installNodeSource(major = 24): void {
  if (pkgManager() === "dnf") {
    runCmd("bash", ["-lc", `curl -fsSL https://rpm.nodesource.com/setup_${major}.x | bash -`]);
    // Kho AppStream có module/gói nodejs riêng — tắt để NodeSource thắng.
    runCmd("dnf", ["-y", "module", "disable", "nodejs"], { silentFail: true });
    dnf(["install", "nodejs"]);
    return;
  }
  runCmd("bash", ["-lc", `curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash -`]);
  aptGet(["install", "-y", "nodejs"]);
}

// --------------------------------------------------------------------------
// Tên gói / dịch vụ / đường dẫn khác nhau giữa hai họ
// --------------------------------------------------------------------------

/** Gói cho từng thành phần. */
export function packagesFor(component: "nginx" | "certbot" | "fail2ban" | "firewall" | "git" | "sudo" | "selinux-tools"): string[] {
  const rhel = isRhel();
  switch (component) {
    case "certbot":
      return ["certbot", "python3-certbot-nginx"];
    case "fail2ban":
      // EPEL: gói meta 'fail2ban' kéo theo fail2ban-firewalld (banaction firewallcmd-*).
      return ["fail2ban"];
    case "firewall":
      return rhel ? ["firewalld"] : ["ufw"];
    case "selinux-tools":
      return rhel ? ["policycoreutils-python-utils"] : [];
    default:
      return [component];
  }
}

/** Thành phần này nằm ở EPEL (họ RHEL, trừ Fedora). */
export function needsEpel(component: "certbot" | "fail2ban"): boolean {
  return isRhel() && !isFedora() && (component === "certbot" || component === "fail2ban");
}

/** Gói Redis: Ubuntu 'redis-server'; RHEL 9 'redis'; RHEL 10 / Fedora mới đã thay bằng Valkey (tương thích giao thức). */
export function redisPackage(): string {
  if (!isRhel()) return "redis-server";
  return dnfHasPackage("redis") ? "redis" : "valkey";
}

/** Nhị phân server Redis-tương-thích có trên máy (redis-server hoặc valkey-server). */
export function redisServerBin(): string | undefined {
  return whichAll("redis-server")[0] ?? whichAll("valkey-server")[0];
}

export function redisCliBin(): string {
  if (commandExists("redis-cli")) return "redis-cli";
  if (commandExists("valkey-cli")) return "valkey-cli";
  return "redis-cli"; // để lỗi 'không tìm thấy' nhắc đúng tên quen thuộc
}

export function redisCliAvailable(): boolean {
  return commandExists("redis-cli") || commandExists("valkey-cli");
}

/** Unit systemd của Redis DÙNG CHUNG (cài từ gói). */
export function redisSystemUnit(): string {
  for (const u of ["redis-server", "redis", "valkey"]) {
    if (existsSync(`/usr/lib/systemd/system/${u}.service`) || existsSync(`/lib/systemd/system/${u}.service`) || existsSync(`/etc/systemd/system/${u}.service`)) return u;
  }
  return isRhel() ? "redis" : "redis-server";
}

/** File cấu hình chính của Redis dùng chung. */
export function redisMainConf(): string {
  for (const p of ["/etc/redis/redis.conf", "/etc/valkey/valkey.conf", "/etc/redis.conf"]) if (existsSync(p)) return p;
  return isRhel() && !dnfHasPackage("redis") ? "/etc/valkey/valkey.conf" : "/etc/redis/redis.conf";
}

/** Thư mục drop-in của napp cho Redis dùng chung (cạnh file cấu hình chính). */
export function redisConfDir(): string {
  const main = redisMainConf();
  return main === "/etc/redis.conf" ? "/etc/redis/conf.d" : `${main.slice(0, main.lastIndexOf("/"))}/conf.d`;
}

/**
 * Gói redis/valkey không tự include conf.d/*.conf — thêm dòng include vào file
 * cấu hình chính (một lần) để drop-in của napp có hiệu lực.
 */
export function ensureRedisConfInclude(): void {
  const main = redisMainConf();
  if (!existsSync(main)) return;
  const content = readFileSync(main, "utf8");
  // napp 1.37.0 ghi lại file này thành root:root -> valkey không đọc được.
  // Trả chủ/nhóm về đúng như gói rpm khai báo (idempotent, rẻ).
  if (isRhel()) execCapture("rpm", ["--setugids", pkgInstalled("valkey") ? "valkey" : "redis"]);
  if (content.includes("conf.d/*.conf")) return;
  writeFile(main, `${content.replace(/\n*$/, "\n")}include ${redisConfDir()}/*.conf\n`, 0o640, isRhel() ? redisConfOwnership(main) : {});
}

// Họ RHEL: redis.conf/valkey.conf thuộc root:redis, redis:root hay valkey:root
// (tuỳ bản gói) 0640 — ghi lại phải giữ NGUYÊN chủ và nhóm, không thì
// redis/valkey không đọc được cấu hình của chính nó và không khởi động lại được.
function redisConfOwnership(path: string): { owner?: string; group?: string } {
  const [u, g] = execCapture("stat", ["-c", "%U %G", path]).stdout.trim().split(" ");
  return { ...(u && u !== "root" ? { owner: u } : {}), group: g || "root" };
}

/** Thư mục drop-in cấu hình MariaDB/MySQL được file chính include sẵn. */
export function mysqlConfDir(): string {
  return isRhel() ? "/etc/my.cnf.d" : "/etc/mysql/conf.d";
}

/** Log xác thực SSH (chỉ để ghi vào jail; backend systemd đọc journal). */
export function authLogPath(): string {
  return isRhel() ? "/var/log/secure" : "/var/log/auth.log";
}

/**
 * secure_path của sudo trên họ RHEL là /sbin:/bin:/usr/sbin:/usr/bin — KHÔNG có
 * /usr/local/bin (Ubuntu có). Nhị phân napp/bun cài ở /usr/local/bin sẽ "command
 * not found" khi chạy 'sudo napp' hay 'sudo -u <app> bun install'. Tạo symlink
 * trong /usr/bin. Không làm gì trên Ubuntu hoặc khi /usr/bin đã có bản riêng.
 */
export function ensureSudoVisible(cmd: string): void {
  if (!isRhel()) return;
  const local = `/usr/local/bin/${cmd}`;
  const sys = `/usr/bin/${cmd}`;
  if (!existsSync(local) || existsSync(sys)) return;
  runCmd("ln", ["-s", local, sys], { silentFail: true });
}

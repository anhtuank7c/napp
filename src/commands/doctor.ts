import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execCapture, runCmd, commandExists, requireRoot, isServiceActive } from "../lib/exec";
import { info, ok, warn, danger, colorText, section, step, die, type LogColor } from "../lib/log";
import { hasApt, aptGet, waitForAptLocks, APT_LOCK_TIMEOUT_S, pendingUpdates, rebootRequired, unitStaleLibraries, isCriticalPackage, aptIndexAgeSeconds, type PendingUpdate } from "../lib/apt";
import { assessNginxCves, nodeLifecycle } from "../lib/cve";
import { scanProject, checkFreshReleases, SEVERITY_ORDER, type ProjectTarget, type ProjectScanResult, type Severity } from "../lib/deps";
import { loadState, svcSystemdName, serviceNameFor, type PackageManager } from "../lib/state";
import { exposedEngines, exposureMessage } from "../lib/db";

// --------------------------------------------------------------------------
// 'napp doctor' — soi RỦI RO BẢO MẬT của máy chủ và của mã nguồn đang chạy:
//   doctor system  : bản vá đang chờ, tiến trình còn chạy thư viện cũ, CVE nổi
//                    bật của nginx, vòng đời Node.js
//   doctor deps    : rủi ro chuỗi cung ứng trong dependencies từng app/service
//   doctor upgrade : cài bản vá (mặc định CHỈ bản vá bảo mật) + restart đúng
//                    dịch vụ để bản vá thực sự có hiệu lực
// --------------------------------------------------------------------------

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "NGHIÊM TRỌNG",
  high: "CAO",
  medium: "TRUNG BÌNH",
  low: "THẤP",
  info: "THÔNG TIN",
};

// Màu theo mức độ: đỏ cho những mức cần xử lý (dễ nhặt ra giữa màn hình đầy
// chữ), vàng cho mức trung bình, xám cho phần chỉ để tham khảo.
const SEVERITY_COLOR: Record<Severity, LogColor> = {
  critical: "redBold",
  high: "red",
  medium: "yellow",
  low: "blue",
  info: "dim",
};

// Bề rộng nhãn dài nhất ("[NGHIÊM TRỌNG]") — canh cột TRƯỚC khi tô màu, vì mã
// màu ANSI cũng bị tính vào độ dài chuỗi nếu padEnd sau khi tô.
const SEVERITY_TAG_WIDTH = 14;

function printSeverity(sev: Severity, text: string): void {
  const color = SEVERITY_COLOR[sev];
  const tag = colorText(color, `[${SEVERITY_LABEL[sev]}]`.padEnd(SEVERITY_TAG_WIDTH));
  // Mức cao thì tô đỏ cả nội dung; mức thấp để nguyên cho đỡ nhiễu mắt.
  const body = sev === "critical" || sev === "high" ? colorText(color, text) : text;
  console.log(`  ${tag} ${body}`);
}

async function confirm(question: string, autoYes: boolean): Promise<boolean> {
  if (autoYes) return true;
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

// Các unit napp quan tâm khi kiểm tra "đã vá nhưng chưa restart".
function managedUnits(): string[] {
  const st = loadState();
  return [
    ...["nginx", "mariadb", "mysql", "postgresql", "mongod", "redis-server", "ssh", "sshd", "fail2ban"].filter((u) => isServiceActive(u)),
    ...Object.values(st.apps).map((a) => `${serviceNameFor(a.domain)}.service`),
    ...Object.values(st.services).map((s) => `${svcSystemdName(s.name)}.service`),
  ];
}

function nginxUpstreamVersion(): string | undefined {
  if (!commandExists("nginx")) return undefined;
  const res = execCapture("nginx", ["-v"]);
  const m = `${res.stderr}${res.stdout}`.match(/nginx\/(\d+\.\d+\.\d+)/);
  return m?.[1];
}

// Phiên bản GÓI của bản phân phối (vd 1.24.0-2ubuntu7.5) — đây mới là con số
// phản ánh đã nhận bản vá backport tới đâu, khác số upstream (1.24.0) vốn
// đứng yên suốt vòng đời bản phân phối.
function nginxPackageInfo(): { pkg: string; version: string } | undefined {
  for (const pkg of ["nginx-core", "nginx-full", "nginx-light", "nginx-extras", "nginx", "nginx-common"]) {
    const res = execCapture("dpkg-query", ["-W", "-f=${Version}", pkg]);
    if (res.code === 0 && res.stdout.trim()) return { pkg, version: res.stdout.trim() };
  }
  return undefined;
}

// Changelog của gói đã cài — nơi bản vá backport GHI LẠI mã CVE đã sửa. Đọc
// thẳng file trên đĩa (không cần mạng, không cần 'apt changelog' vốn phải tải
// về từ server và hay hỏng khi thiếu kho source).
function nginxChangelog(): { text: string; path: string } | undefined {
  const candidates: string[] = [];
  for (const dir of ["nginx-common", "nginx-core", "nginx", "nginx-full", "nginx-light", "nginx-extras"]) {
    candidates.push(`/usr/share/doc/${dir}/changelog.Debian.gz`, `/usr/share/doc/${dir}/changelog.gz`, `/usr/share/doc/${dir}/changelog.Debian`);
  }
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path);
      const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      if (text.trim()) return { text, path };
    } catch {
      /* file hỏng/không đọc được -> thử ứng viên kế tiếp */
    }
  }
  return undefined;
}

// Cấu hình ĐANG CHẠY, gộp mọi include ('nginx -T'). Cần root; không có root
// thì trả undefined để phần đánh giá biết là "chưa đối chiếu được" thay vì
// kết luận nhầm là "không bật".
function nginxRunningConfig(): string | undefined {
  if (!commandExists("nginx")) return undefined;
  const res = execCapture("nginx", ["-T"]);
  if (res.code !== 0 || !res.stdout.trim()) return undefined;
  return res.stdout;
}

export interface DoctorSystemOptions {
  refresh: boolean; // chạy 'apt-get update' trước khi đọc (cần root)
}

export interface SystemReport {
  security: PendingUpdate[];
  other: PendingUpdate[];
  staleUnits: { unit: string; libs: string[] }[];
  reboot: { required: boolean; packages: string[] };
}

export function collectSystemReport(opts: DoctorSystemOptions): SystemReport {
  if (opts.refresh) {
    if (process.getuid && process.getuid() !== 0) {
      warn("Bỏ qua làm mới chỉ mục apt (cần quyền root) — kết quả dựa trên chỉ mục đã có sẵn, có thể cũ.");
    } else {
      info("Đang làm mới chỉ mục gói (apt-get update)...");
      aptGet(["update", "-qq"], { silentFail: true });
    }
  }

  const pending = pendingUpdates();
  const security = pending.filter((p) => p.security);
  const other = pending.filter((p) => !p.security);

  const staleUnits: { unit: string; libs: string[] }[] = [];
  for (const unit of managedUnits()) {
    const libs = unitStaleLibraries(unit);
    if (libs && libs.length > 0) staleUnits.push({ unit, libs });
  }

  return { security, other, staleUnits, reboot: rebootRequired() };
}

export function cmdDoctorSystem(opts: DoctorSystemOptions): SystemReport | undefined {
  section("Kiểm tra bản vá bảo mật của hệ thống");

  if (!hasApt()) {
    warn("Không tìm thấy apt-get — phần kiểm tra bản vá chỉ hỗ trợ Ubuntu/Debian. Bỏ qua.");
    return undefined;
  }

  const report = collectSystemReport(opts);

  // --- chỉ mục apt có mới không: quyết định độ tin cậy của cả phần này ---
  const age = aptIndexAgeSeconds();
  if (age !== undefined && age > 86_400 * 2) {
    warn(
      `Chỉ mục gói đã cũ ${Math.floor(age / 86_400)} ngày — danh sách bản vá dưới đây có thể THIẾU. ` +
        `Chạy 'sudo napp doctor system' (tự làm mới) hoặc 'sudo apt-get update'.`
    );
  }

  // --- bản vá bảo mật đang chờ ---
  if (report.security.length === 0) {
    ok("Không có bản vá bảo mật nào đang chờ cài.");
  } else {
    const critical = report.security.filter((p) => isCriticalPackage(p.pkg));
    danger(`Có ${report.security.length} gói CÓ BẢN VÁ BẢO MẬT đang chờ cài${critical.length ? ` (${critical.length} gói TRỌNG YẾU)` : ""}:`);
    for (const p of report.security.slice(0, 25)) {
      const line = `${p.pkg.padEnd(28)} ${p.currentVersion || "(mới)"} -> ${p.newVersion}`;
      // Gói trọng yếu (nginx/OpenSSL/OpenSSH/...) tô đỏ để nhặt ra ngay giữa
      // danh sách dài — phần còn lại để xám cho đỡ nhiễu.
      // Canh cùng một cột với dòng có dấu '!' để mắt dò theo cột tên gói.
      if (isCriticalPackage(p.pkg)) console.log(`  ${colorText("redBold", "!")} ${colorText("red", line)}`);
      else console.log(`    ${colorText("dim", line)}`);
    }
    if (report.security.length > 25) console.log(`    ${colorText("dim", `... và ${report.security.length - 25} gói nữa`)}`);
    console.log();
    info("Cài các bản vá này: sudo napp doctor upgrade      (chỉ cài bản vá bảo mật, tự restart dịch vụ liên quan)");
  }
  if (report.other.length > 0) {
    info(`Ngoài ra có ${report.other.length} gói có bản cập nhật thường (không phải bản vá bảo mật) — cài bằng 'sudo napp doctor upgrade --all'.`);
  }

  // --- đã vá nhưng tiến trình vẫn chạy mã cũ ---
  if (report.staleUnits.length > 0) {
    console.log();
    danger(`${report.staleUnits.length} dịch vụ vẫn đang chạy THƯ VIỆN CŨ đã bị thay trên đĩa — bản vá CHƯA có hiệu lực với chúng:`);
    for (const s of report.staleUnits) {
      step(`${s.unit}: ${s.libs.slice(0, 3).join(", ")}${s.libs.length > 3 ? ` (+${s.libs.length - 3})` : ""}`);
    }
    info(`Khắc phục: sudo systemctl restart ${report.staleUnits.map((s) => s.unit).join(" ")}`);
  } else if (process.getuid && process.getuid() === 0) {
    ok("Không có dịch vụ nào còn nạp thư viện cũ (bản vá đã cài đều đã có hiệu lực).");
  } else {
    info("Bỏ qua kiểm tra 'dịch vụ còn nạp thư viện cũ' — cần chạy bằng sudo để đọc được /proc của tiến trình khác.");
  }

  // --- database lộ ra mạng ---
  const exposed = exposedEngines();
  if (exposed.length > 0) {
    console.log();
    for (const x of exposed) danger(exposureMessage(x));
  } else if (process.getuid && process.getuid() === 0) {
    ok("Không database nào lắng nghe ngoài 127.0.0.1.");
  }

  // --- cần khởi động lại máy ---
  if (report.reboot.required) {
    console.log();
    warn(
      `Máy cần KHỞI ĐỘNG LẠI để bản vá có hiệu lực (thường là nhân/kernel hoặc libc)` +
        (report.reboot.packages.length ? `: ${report.reboot.packages.slice(0, 6).join(", ")}` : "") +
        ". Hãy hẹn một khung giờ ít truy cập rồi 'sudo reboot'."
    );
  }

  // --- nginx: CVE nổi bật theo phiên bản upstream ---
  console.log();
  const nginxVersion = nginxUpstreamVersion();
  if (!nginxVersion) {
    info("Không đọc được phiên bản nginx (chưa cài?) — bỏ qua đối chiếu CVE.");
  } else {
    const nginxPatch = report.security.find((p) => /^nginx/.test(p.pkg));
    const pkgInfo = nginxPackageInfo();
    const changelog = nginxChangelog();
    const config = nginxRunningConfig();
    const buildFlags = `${execCapture("nginx", ["-V"]).stderr}${execCapture("nginx", ["-V"]).stdout}`;

    if (nginxPatch) {
      danger(
        `nginx ${nginxVersion} (gói ${nginxPatch.currentVersion}) CÓ BẢN VÁ BẢO MẬT ĐANG CHỜ -> ${nginxPatch.newVersion}. ` +
          `Đây là tín hiệu chắc chắn nhất: hãy cài ngay bằng 'sudo napp doctor upgrade'.`
      );
    } else {
      ok(
        `nginx ${nginxVersion}${pkgInfo ? ` (gói ${pkgInfo.pkg} ${pkgInfo.version})` : ""}: ` +
          `không có bản vá bảo mật nào đang chờ từ kho của bản phân phối.`
      );
    }

    // Đối chiếu từng CVE bằng BẰNG CHỨNG trên máy (changelog gói, cờ biên dịch,
    // cấu hình đang chạy) thay vì chỉ so số phiên bản upstream — vì bản phân
    // phối vá ngược mà giữ nguyên số, so số sẽ báo động mãi không tắt.
    const assessments = assessNginxCves(nginxVersion, { changelog: changelog?.text, buildFlags, config });
    if (assessments.length > 0) {
      console.log();
      const patched = assessments.filter((a) => a.verdict === "patched");
      const na = assessments.filter((a) => a.verdict === "not-applicable");
      const affected = assessments.filter((a) => a.verdict === "affected");

      info(
        `Đối chiếu ${assessments.length} CVE đáng chú ý của nhánh nginx ${nginxVersion} với bằng chứng trên máy này ` +
          `(changelog gói${changelog ? " ✓" : " ✗ không đọc được"}, cấu hình đang chạy${config ? " ✓" : " ✗ cần sudo"}):`
      );

      for (const a of patched) {
        console.log(`  ${colorText("green", "[ĐÃ VÁ]".padEnd(SEVERITY_TAG_WIDTH))} ${a.cve.id} — ${a.reason}`);
      }
      for (const a of na) {
        console.log(`  ${colorText("dim", "[KHÔNG DÍNH]".padEnd(SEVERITY_TAG_WIDTH))} ${colorText("dim", `${a.cve.id} — ${a.reason}`)}`);
      }
      for (const a of affected) {
        printSeverity(a.cve.severity === "critical" ? "critical" : a.cve.severity === "high" ? "high" : "medium", `${a.cve.id} — ${a.cve.summary}`);
        step(`Vì sao còn nằm đây: ${a.reason}`);
        if (a.cve.condition) step(a.cve.condition);
        step(`Upstream vá ở: ${a.cve.fixedIn.join(" / ")}`);
      }

      console.log();
      if (affected.length === 0) {
        ok(`Cả ${assessments.length} CVE đều đã được vá hoặc không với tới được máy này — không cần làm gì thêm.`);
      } else {
        info(
          `Còn ${affected.length} CVE chưa chứng minh được là đã xử lý. Kiểm chứng thủ công:\n` +
            (changelog ? `         zgrep -i '${affected[0]!.cve.cveIds[0]}' ${changelog.path}\n` : `         apt changelog nginx | head -40\n`) +
            `         https://ubuntu.com/security/${affected[0]!.cve.cveIds[0]}   (tra bản phân phối đã vá ở phiên bản gói nào)`
        );
        info(
          "Nếu kho của bản phân phối KHÔNG còn phát hành bản vá cho nginx (bản Ubuntu/Debian đã hết hỗ trợ), hãy nâng cấp OS,\n" +
            "       hoặc chuyển sang kho chính thức nginx.org để có bản mới nhất:  https://nginx.org/en/linux_packages.html"
        );
      }
    }
  }

  // --- Node.js: bản EOL không còn nhận bản vá nào nữa ---
  console.log();
  if (commandExists("node")) {
    const v = execCapture("node", ["--version"]).stdout.trim();
    const life = nodeLifecycle(v);
    if (life.eol) {
      danger(
        `Node.js ${v} đã HẾT HẠN HỖ TRỢ${life.eolDate ? ` (EOL ${life.eolDate})` : " (bản lẻ, không phải LTS)"} — ` +
          `sẽ KHÔNG còn nhận bản vá bảo mật nào nữa, kể cả lỗi nghiêm trọng.`
      );
      info(
        "Nâng cấp lên LTS còn hỗ trợ:\n" +
          "         curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt-get install -y nodejs\n" +
          "       Sau đó chạy lại 'napp app deploy <domain>' / 'napp service deploy <name>' để build lại native module."
      );
    } else {
      ok(`Node.js ${v}${life.eolDate ? ` — còn hỗ trợ tới ${life.eolDate}` : ""}`);
    }
  }

  return report;
}

// ---------------------------------------------------------------- deps ---

export interface DoctorDepsOptions {
  target?: string; // domain của app hoặc tên service; bỏ trống = quét tất cả
  audit: boolean; // chạy audit của package manager (cần mạng)
  deep: boolean; // tra thêm tuổi bản phát hành trên registry (cần mạng)
}

function allTargets(): ProjectTarget[] {
  const st = loadState();
  const targets: ProjectTarget[] = [];
  for (const a of Object.values(st.apps)) {
    targets.push({
      label: `app web ${a.domain}`,
      dir: a.webRoot,
      user: a.user,
      pm: (a.packageManager ?? "npm") as PackageManager,
    });
  }
  for (const s of Object.values(st.services)) {
    targets.push({
      label: `service ${s.name}`,
      dir: s.workDir,
      user: s.user,
      pm: (s.packageManager ?? "npm") as PackageManager,
    });
  }
  return targets;
}

function resolveTargets(name?: string): ProjectTarget[] {
  const all = allTargets();
  if (!name) return all;
  const found = all.filter((t) => t.label.endsWith(` ${name}`));
  if (found.length === 0) {
    die(
      `Không tìm thấy app hoặc service tên '${name}' trong registry.\n` +
        `  Xem danh sách: napp app list  /  napp service list`
    );
  }
  return found;
}

export async function cmdDoctorDeps(opts: DoctorDepsOptions): Promise<ProjectScanResult[]> {
  section("Quét rủi ro chuỗi cung ứng của dependencies");
  const targets = resolveTargets(opts.target);
  if (targets.length === 0) {
    info("Chưa có app/service nào được napp quản lý — không có gì để quét.");
    return [];
  }
  // Audit phải chạy DƯỚI USER CỦA APP (để cache npm/pnpm không bị root tạo ra
  // trong thư mục app) — việc đó cần sudo. Không có root thì bỏ hẳn phần audit
  // thay vì để sudo thất bại ở từng dự án.
  let audit = opts.audit;
  if (audit && (process.getuid?.() ?? 0) !== 0) {
    warn("Chưa chạy bằng sudo — BỎ QUA phần audit lỗ hổng (audit phải chạy dưới user của app). Dùng 'sudo napp doctor deps' để quét đầy đủ.");
    audit = false;
  }

  const results: ProjectScanResult[] = [];
  for (const t of targets) {
    console.log();
    info(`${t.label}  (${t.dir}, ${t.pm})`);
    const res = scanProject(t, { audit });
    if (res.skipped) {
      step(`Bỏ qua: ${res.skipped}`);
      results.push(res);
      continue;
    }
    step(`Đã cài ${res.packageCount} package trong node_modules`);

    if (opts.deep) {
      const fresh = await checkFreshReleases(t);
      if (fresh.error) {
        step(`Không tra được tuổi bản phát hành: ${fresh.error}`);
      } else if (fresh.fresh.length > 0) {
        res.findings.unshift({
          severity: "medium",
          title: `${fresh.fresh.length} dependency vừa có bản phát hành rất mới (<= 14 ngày)`,
          detail:
            "Gói bị chiếm tài khoản thường chỉ tồn tại trên registry vài giờ tới vài ngày trước khi bị gỡ. " +
            "Bản phát hành còn quá mới mà server đã kéo về là lúc đáng dừng lại kiểm tra:\n    " +
            fresh.fresh
              .slice(0, 8)
              .map((f) => `${f.name}@${f.installedVersion} — publish ${f.ageDays} ngày trước${f.isLatest ? " (đang là latest)" : ""}`)
              .join("\n    "),
          fix:
            "Đối chiếu changelog/commit của bản mới trên trang chính thức của thư viện trước khi giữ lại.\n" +
            "    Nếu không rõ nguồn gốc: ghim tạm về bản cũ đã dùng ổn định, commit lockfile, deploy lại.",
        });
        res.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
      }
    }

    if (res.findings.length === 0) {
      ok("Không phát hiện rủi ro đáng chú ý.");
    } else {
      for (const f of res.findings) {
        printSeverity(f.severity, f.title);
        step(f.detail);
        step(`Cách xử lý: ${f.fix}`);
      }
    }
    results.push(res);
  }

  // --- tổng kết ---
  const counts: Partial<Record<Severity, number>> = {};
  for (const r of results) for (const f of r.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  console.log();
  const summary = (["critical", "high", "medium", "low", "info"] as Severity[])
    .filter((s) => counts[s])
    .map((s) => `${SEVERITY_LABEL[s]}: ${counts[s]}`)
    .join("  ·  ");
  if (!summary) ok(`Đã quét ${results.length} dự án — không có phát hiện nào.`);
  else {
    section("Tổng kết dependencies");
    console.log(`  ${summary}`);
    if (!opts.deep) info("Thêm '--deep' để tra thêm tuổi bản phát hành của dependency trực tiếp trên registry npm (cần mạng).");
  }
  return results;
}

// ------------------------------------------------------------- upgrade ---

export interface DoctorUpgradeOptions {
  all: boolean; // cài mọi cập nhật, không chỉ bản vá bảo mật
  only: string[]; // chỉ nâng cấp các gói này (vd: nginx)
  yes: boolean;
  restart: boolean; // tự restart dịch vụ còn nạp thư viện cũ sau khi cài
}

export async function cmdDoctorUpgrade(opts: DoctorUpgradeOptions): Promise<void> {
  requireRoot();
  if (!hasApt()) die("Không tìm thấy apt-get — lệnh này chỉ hỗ trợ Ubuntu/Debian.");

  section("Cài bản vá cho hệ thống");
  info("Đang làm mới chỉ mục gói (apt-get update)...");
  aptGet(["update", "-qq"]);

  const pending = pendingUpdates();
  if (pending.length === 0) {
    ok("Hệ thống đã ở bản mới nhất — không có gì để cài.");
    return;
  }

  let selected: PendingUpdate[];
  let scopeLabel: string;
  if (opts.only.length > 0) {
    selected = pending.filter((p) => opts.only.some((o) => p.pkg === o || p.pkg.startsWith(`${o}-`) || p.pkg.startsWith(`${o}.`)));
    scopeLabel = `các gói được chỉ định (${opts.only.join(", ")})`;
    if (selected.length === 0) {
      info(`Không có bản cập nhật nào đang chờ cho: ${opts.only.join(", ")}. Không cần làm gì.`);
      return;
    }
  } else if (opts.all) {
    selected = pending;
    scopeLabel = "TẤT CẢ bản cập nhật đang chờ";
  } else {
    selected = pending.filter((p) => p.security);
    scopeLabel = "bản vá BẢO MẬT";
    if (selected.length === 0) {
      ok("Không có bản vá bảo mật nào đang chờ.");
      if (pending.length > 0) info(`Vẫn còn ${pending.length} bản cập nhật thường — cài bằng 'sudo napp doctor upgrade --all'.`);
      return;
    }
  }

  console.log();
  info(`Sẽ cài ${selected.length} gói (${scopeLabel}):`);
  for (const p of selected.slice(0, 30)) step(`${p.pkg.padEnd(28)} ${p.currentVersion || "(mới)"} -> ${p.newVersion}`);
  if (selected.length > 30) step(`... và ${selected.length - 30} gói nữa`);

  console.log();
  const proceed = await confirm(`Tiến hành cài ${selected.length} gói ở trên?`, opts.yes);
  if (!proceed) {
    info("Đã huỷ. Không thay đổi gì.");
    return;
  }

  // --force-confold: GIỮ NGUYÊN file cấu hình hiện có khi gói mới mang bản
  // cấu hình khác. Bắt buộc phải có, nếu không dpkg sẽ dừng lại hỏi tương tác
  // (treo trong script) hoặc ghi đè cấu hình nginx đang chạy.
  const aptArgs = [
    "-y",
    "-o",
    `DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_S}`,
    "-o",
    "Dpkg::Options::=--force-confold",
    "-o",
    "Dpkg::Options::=--force-confdef",
    "install",
    "--only-upgrade",
    ...selected.map((p) => p.pkg),
  ];
  waitForAptLocks();
  runCmd("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", ...aptArgs]);
  ok(`Đã cài ${selected.length} gói.`);

  // --- kiểm tra cấu hình nginx trước khi restart ---
  const touchedNginx = selected.some((p) => /^nginx/.test(p.pkg));
  if (touchedNginx && commandExists("nginx")) {
    const t = execCapture("nginx", ["-t"]);
    if (t.code !== 0) {
      warn(`Cấu hình nginx KHÔNG hợp lệ sau khi nâng cấp — KHÔNG restart để tránh sập site:\n${t.stderr.trim()}`);
      die("Hãy sửa cấu hình rồi chạy 'sudo nginx -t && sudo systemctl restart nginx'.");
    }
    ok("Cấu hình nginx hợp lệ (nginx -t).");
  }

  // --- restart các dịch vụ còn nạp thư viện cũ ---
  const stale = managedUnits()
    .map((unit) => ({ unit, libs: unitStaleLibraries(unit) ?? [] }))
    .filter((s) => s.libs.length > 0);

  if (stale.length === 0) {
    ok("Không dịch vụ nào còn nạp thư viện cũ — bản vá đã có hiệu lực.");
  } else if (!opts.restart) {
    danger(`${stale.length} dịch vụ vẫn chạy thư viện cũ (bản vá CHƯA có hiệu lực): ${stale.map((s) => s.unit).join(", ")}`);
    info(`Khắc phục: sudo systemctl restart ${stale.map((s) => s.unit).join(" ")}`);
  } else {
    console.log();
    info(`${stale.length} dịch vụ cần khởi động lại để bản vá có hiệu lực: ${stale.map((s) => s.unit).join(", ")}`);
    const doRestart = await confirm("Khởi động lại các dịch vụ này ngay? (mỗi dịch vụ gián đoạn dưới một giây)", opts.yes);
    if (!doRestart) {
      info(`Bỏ qua. Khi nào tiện: sudo systemctl restart ${stale.map((s) => s.unit).join(" ")}`);
    } else {
      for (const s of stale) {
        runCmd("systemctl", ["restart", s.unit], { silentFail: true });
        ok(`Đã khởi động lại ${s.unit}`);
      }
    }
  }

  const reboot = rebootRequired();
  if (reboot.required) {
    console.log();
    warn(
      "Máy cần KHỞI ĐỘNG LẠI để hoàn tất bản vá (nhân/kernel hoặc libc)" +
        (reboot.packages.length ? `: ${reboot.packages.slice(0, 6).join(", ")}` : "") +
        ". Hãy hẹn khung giờ ít truy cập rồi 'sudo reboot'."
    );
  }
}

// ------------------------------------------------------------------ all ---

export interface DoctorAllOptions extends DoctorSystemOptions {
  audit: boolean;
  deep: boolean;
}

export async function cmdDoctor(opts: DoctorAllOptions): Promise<void> {
  const report = cmdDoctorSystem({ refresh: opts.refresh });
  const deps = await cmdDoctorDeps({ audit: opts.audit, deep: opts.deep });

  section("Tóm tắt");
  const secCount = report?.security.length ?? 0;
  const depCritical = deps.reduce((n, r) => n + r.findings.filter((f) => f.severity === "critical" || f.severity === "high").length, 0);

  if (secCount === 0 && depCritical === 0) {
    ok("Không phát hiện rủi ro bảo mật nào cần xử lý ngay.");
  } else {
    if (secCount > 0) danger(`${secCount} gói hệ thống có bản vá bảo mật đang chờ  ->  sudo napp doctor upgrade`);
    if (depCritical > 0) danger(`${depCritical} rủi ro mức CAO/NGHIÊM TRỌNG trong dependencies  ->  xem phần hướng dẫn xử lý ở trên`);
  }
  console.log();
  info("Nên chạy 'sudo napp doctor' định kỳ (hàng tuần) — và luôn 'napp update' để có bảng CVE mới nhất.");
}

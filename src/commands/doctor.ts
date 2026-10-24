import { existsSync, readFileSync } from "node:fs";
import { ask } from "../lib/prompt";
import { gunzipSync } from "node:zlib";
import { execCapture, runCmd, commandExists, requireRoot, isServiceActive } from "../lib/exec";
import { info, ok, warn, danger, colorText, section, step, die, type LogColor } from "../lib/log";
import { hasApt, aptGet, waitForAptLocks, APT_LOCK_TIMEOUT_S, pendingUpdates, rebootRequired, unitStaleLibraries, isCriticalPackage, aptIndexAgeSeconds, type PendingUpdate } from "../lib/apt";
import { assessNginxCves, assessNode, nodeFixedVersion, nodeLifecycle, type NodeAssessment, type NodeFeed } from "../lib/cve";
import { loadNodeFeed } from "../lib/nodefeed";
import { scanProject, auditFindings, checkFreshReleases, SEVERITY_ORDER, type DepFinding, type ProjectTarget, type ProjectScanResult, type Severity } from "../lib/deps";
import { resolveInstalledPackages, osvScan, osvDepFindings, type OsvScanResult } from "../lib/osv";
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
  const ans = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(ans.trim());
}

// Các unit napp quan tâm khi kiểm tra "đã vá nhưng chưa restart".
function managedUnits(): string[] {
  const st = loadState();
  return [
    ...["nginx", "mariadb", "mysql", "postgresql", "mongod", "redis-server", "ssh", "sshd", "fail2ban"].filter((u) => isServiceActive(u)),
    ...Object.values(st.apps).map((a) => `${serviceNameFor(a.domain)}.service`),
    ...Object.values(st.services).map((s) => `${svcSystemdName(s.name)}.service`),
    // Redis riêng: vá libssl/redis mà không restart thì chúng vẫn chạy mã cũ.
    ...Object.keys(st.redisInstances ?? {}).map((id) => `napp-redis-${id}.service`),
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

// --- Node.js: phiên bản đang chạy + bằng chứng vá -------------------------
export interface NodeStatus {
  version: string; // vd "v24.10.0"
  execPath: string; // binary thật (đã giải symlink)
  pkgVersion?: string; // phiên bản gói nodejs của dpkg, nếu node này đến từ gói
  nodesource: boolean; // gói từ NodeSource (mang số upstream thật, không backport)
  assessments: NodeAssessment[];
  affected: NodeAssessment[];
  fixedVersion?: string; // bản vá cùng major; undefined = major EOL, phải lên major khác
  feed: NodeFeed;
}

export function nodeStatus(feed: NodeFeed): NodeStatus | undefined {
  if (!commandExists("node")) return undefined;
  const res = execCapture("node", ["-p", "process.version + ' ' + require('fs').realpathSync(process.execPath)"]);
  const [version, execPath] = res.stdout.trim().split(" ");
  if (res.code !== 0 || !version || !execPath) return undefined;
  // Chỉ tin gói dpkg/changelog khi node đang chạy ĐÚNG là binary của gói đó —
  // /usr/local/bin/node cài tay mà lấy changelog của gói nodejs sẽ báo "đã vá" nhầm.
  const fromPkg = /^nodejs:/m.test(execCapture("dpkg-query", ["-S", execPath]).stdout);
  const pkgVersion = fromPkg ? execCapture("dpkg-query", ["-W", "-f=${Version}", "nodejs"]).stdout.trim() || undefined : undefined;
  let changelog: string | undefined;
  if (fromPkg) {
    for (const path of ["/usr/share/doc/nodejs/changelog.Debian.gz", "/usr/share/doc/nodejs/changelog.Debian"]) {
      if (!existsSync(path)) continue;
      try {
        const raw = readFileSync(path);
        changelog = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
        break;
      } catch {
        /* file hỏng/không đọc được -> thử ứng viên kế tiếp */
      }
    }
  }
  const nodesource = /nodesource/i.test(pkgVersion ?? "");
  const assessments = assessNode(version, feed, { changelog, distroBackport: Boolean(pkgVersion) && !nodesource });
  const affected = assessments.filter((a) => a.verdict === "affected");
  return { version, execPath, pkgVersion, nodesource, assessments, affected, fixedVersion: nodeFixedVersion(assessments), feed };
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

// Đối chiếu CVE nginx bằng bằng chứng trên máy — dùng chung cho 'doctor
// system' (in chi tiết) và lần quét định kỳ (gửi thông báo).
export function nginxCveReport() {
  const version = nginxUpstreamVersion();
  if (!version) return undefined;
  const changelog = nginxChangelog();
  const config = nginxRunningConfig();
  const buildFlags = `${execCapture("nginx", ["-V"]).stderr}${execCapture("nginx", ["-V"]).stdout}`;
  return { version, changelog, config, assessments: assessNginxCves(version, { changelog: changelog?.text, buildFlags, config }) };
}

export interface DoctorSystemOptions {
  refresh: boolean; // chạy 'apt-get update' trước khi đọc (cần root)
}

export interface SystemReport {
  security: PendingUpdate[];
  other: PendingUpdate[];
  staleUnits: { unit: string; libs: string[] }[];
  reboot: { required: boolean; packages: string[] };
  node?: NodeStatus;
}

export async function collectSystemReport(opts: DoctorSystemOptions): Promise<SystemReport> {
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

  // Dữ liệu lỗ hổng Node: tải mới cùng lúc với 'apt-get update' (refresh), còn
  // --no-refresh thì dùng cache + bảng có sẵn, không ra mạng.
  const { feed, warnings } = await loadNodeFeed({ online: opts.refresh });
  for (const w of warnings) warn(w);

  return { security, other, staleUnits, reboot: rebootRequired(), node: nodeStatus(feed) };
}

export async function cmdDoctorSystem(opts: DoctorSystemOptions): Promise<SystemReport | undefined> {
  section("Kiểm tra bản vá bảo mật của hệ thống");

  if (!hasApt()) {
    warn("Không tìm thấy apt-get — phần kiểm tra bản vá chỉ hỗ trợ Ubuntu/Debian. Bỏ qua.");
    return undefined;
  }

  const report = await collectSystemReport(opts);

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
  const nginx = nginxCveReport();
  if (!nginx) {
    info("Không đọc được phiên bản nginx (chưa cài?) — bỏ qua đối chiếu CVE.");
  } else {
    const { version: nginxVersion, changelog, config, assessments } = nginx;
    const nginxPatch = report.security.find((p) => /^nginx/.test(p.pkg));
    const pkgInfo = nginxPackageInfo();

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
  const node = report.node;
  if (node) {
    const v = node.version;
    const life = nodeLifecycle(v, new Date(), node.feed.eol);
    if (life.eol) {
      danger(
        `Node.js ${v} đã HẾT HẠN HỖ TRỢ${life.eolDate ? ` (EOL ${life.eolDate})` : " (bản lẻ, không phải LTS)"} — ` +
          `sẽ KHÔNG còn nhận bản vá bảo mật nào nữa, kể cả lỗi nghiêm trọng.`
      );
    } else {
      ok(`Node.js ${v}${life.eolDate ? ` — còn hỗ trợ tới ${life.eolDate}` : ""}`);
    }

    // --- Node.js: CVE đã biết của phiên bản đang chạy ---
    info(colorText("dim", `Dữ liệu lỗ hổng Node.js: ${node.feed.source}`));
    for (const a of node.assessments.filter((x) => x.verdict === "patched")) {
      console.log(`  ${colorText("green", "[ĐÃ VÁ]".padEnd(SEVERITY_TAG_WIDTH))} ${a.advisory.id} — ${a.reason}`);
    }
    // Node cũ có thể dính hàng chục mục — in chi tiết những mục nặng nhất (đã
    // xếp theo mức độ), phần còn lại gộp một dòng cho khỏi trôi màn hình.
    const SHOW = 8;
    for (const a of node.affected.slice(0, SHOW)) {
      printSeverity(a.advisory.severity, `${a.advisory.id} — ${a.advisory.summary}`);
      step(`Vì sao còn nằm đây: ${a.reason}`);
      if (a.advisory.condition) step(a.advisory.condition);
      if (a.advisory.ref) step(colorText("dim", a.advisory.ref));
    }
    if (node.affected.length > SHOW) {
      const rest = node.affected.slice(SHOW);
      console.log(`    ${colorText("dim", `... và ${rest.length} lỗ hổng nữa (${rest.map((a) => a.advisory.severity).filter((x, i, arr) => arr.indexOf(x) === i).join("/")}) — cùng được vá khi nâng cấp`)}`);
    }
    if (node.affected.length > 0) {
      console.log();
      printNodeFixHint(node);
    } else if (life.eol) {
      info(
        "Nâng cấp lên LTS còn hỗ trợ:  sudo napp doctor upgrade --node-major 24\n" +
          "       Sau đó chạy lại 'napp app deploy <domain>' / 'napp service deploy <name>' để build lại native module."
      );
    }
  }

  return report;
}

// Hướng dẫn vá Node theo đúng hoàn cảnh: cùng major có bản vá thì chỉ cần
// nâng gói; major đã EOL thì bắt buộc lên major khác (có rủi ro tương thích).
function nodeAffectedLabel(affected: NodeAssessment[]): string {
  const ids = affected.slice(0, 3).map((a) => a.advisory.id).join(", ");
  return affected.length > 3 ? `${ids} (+${affected.length - 3} lỗ hổng khác)` : ids;
}

function printNodeFixHint(node: NodeStatus): void {
  const ids = nodeAffectedLabel(node.affected);
  if (!node.fixedVersion) {
    danger(`Nhánh Node.js ${node.version} đã hết hỗ trợ — KHÔNG có bản vá cho ${ids}. Phải lên major còn hỗ trợ.`);
    info(
      "Lên Node.js 24 LTS:  sudo napp doctor upgrade --node-major 24\n" +
        "       Sau đó chạy lại 'napp app deploy <domain>' / 'napp service deploy <name>' để build lại native module."
    );
  } else if (!node.pkgVersion) {
    danger(`Node.js ${node.version} cần nâng lên >= ${node.fixedVersion} để vá ${ids}.`);
    warn(
      `${node.execPath} KHÔNG thuộc gói apt nào (cài tay/nvm/n) — napp không tự vá được. Cài lại bản >= ${node.fixedVersion} ` +
        `bằng đúng công cụ đã dùng, hoặc chuyển sang node hệ thống:  sudo napp doctor upgrade --node-major ${parseInt(node.version.slice(1), 10)}`
    );
  } else {
    danger(`Node.js ${node.version} cần nâng lên >= ${node.fixedVersion} để vá ${ids}.`);
    info(
      "Vá ngay (cùng nhánh, không đổi major — an toàn cho app):  sudo napp doctor upgrade\n" +
        "       napp tự cài gói nodejs mới rồi khởi động lại MỌI app/service còn chạy node cũ."
    );
    if (!node.nodesource) {
      info(
        `Node đang lấy từ kho của bản phân phối (gói ${node.pkgVersion}) — nếu kho chưa phát hành bản vá,\n` +
          `       chuyển sang NodeSource:  sudo napp doctor upgrade --node-major ${parseInt(node.version.slice(1), 10)}`
      );
    }
  }
  if (node.affected.some((a) => a.advisory.cveIds.includes("CVE-2026-111497"))) {
    info(
      "Chưa vá được ngay? Giảm thiểu CVE-2026-111497: không giải nén Brotli từ nguồn lạ — từ chối body request có\n" +
        "       'Content-Encoding: br', gửi 'Accept-Encoding: gzip, deflate' khi fetch() ra ngoài. Vá vẫn là bắt buộc."
    );
  }
}

// ---------------------------------------------------------------- deps ---

export interface DoctorDepsOptions {
  target?: string; // domain của app hoặc tên service; bỏ trống = quét tất cả
  audit: boolean; // tra lỗ hổng + mã độc đã biết: OSV.dev, dự phòng là audit của package manager (cần mạng)
  deep: boolean; // tra thêm tuổi bản phát hành trên registry (cần mạng)
}

export function allTargets(): ProjectTarget[] {
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

export interface KnownVulnScan {
  findings: DepFinding[];
  osv?: OsvScanResult; // có khi quét bằng OSV thành công
  source: string; // đã dùng nguồn nào, vì sao — in cho người dùng
}

// Lỗ hổng + mã độc ĐÃ BIẾT của một dự án. Ưu tiên OSV trên các gói đang nằm
// trong node_modules (xem lib/osv.ts về lý do); không được thì lùi về audit
// của package manager như trước — không bao giờ im lặng bỏ qua.
export async function scanKnownVulns(t: ProjectTarget): Promise<KnownVulnScan> {
  let pkgs: ReturnType<typeof resolveInstalledPackages>;
  try {
    pkgs = resolveInstalledPackages(t.dir);
  } catch (e) {
    pkgs = undefined;
    warn(`Không đọc được node_modules của ${t.label}: ${(e as Error).message}`);
  }
  if (pkgs) {
    try {
      const r = await osvScan(pkgs);
      return {
        findings: osvDepFindings(t, r),
        osv: r,
        source: `OSV.dev: ${r.prodCount} package production được tra lỗ hổng, ${r.devCount} package dev/build chỉ soi mã độc`,
      };
    } catch (e) {
      return { findings: auditFindings(t), source: `OSV.dev không dùng được (${(e as Error).message}) — dùng '${t.pm} audit'` };
    }
  }
  return { findings: auditFindings(t), source: `không đọc được node_modules — dùng '${t.pm} audit'` };
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
  // Tra lỗ hổng cần root: đọc node_modules của app (thư mục 0750 của user app)
  // cho OSV, hoặc chạy audit DƯỚI USER CỦA APP khi phải lùi về (để cache
  // npm/pnpm không bị root tạo ra trong thư mục app). Không có root thì bỏ hẳn
  // phần này thay vì thất bại ở từng dự án.
  let audit = opts.audit;
  if (audit && (process.getuid?.() ?? 0) !== 0) {
    warn("Chưa chạy bằng sudo — BỎ QUA phần tra lỗ hổng/mã độc (cần đọc node_modules của từng app). Dùng 'sudo napp doctor deps' để quét đầy đủ.");
    audit = false;
  }

  const results: ProjectScanResult[] = [];
  for (const t of targets) {
    console.log();
    info(`${t.label}  (${t.dir}, ${t.pm})`);
    const res = scanProject(t, { audit: false });
    if (res.skipped) {
      step(`Bỏ qua: ${res.skipped}`);
      results.push(res);
      continue;
    }
    step(`Đã cài ${res.packageCount} package trong node_modules`);
    if (audit) {
      const known = await scanKnownVulns(t);
      step(known.source);
      res.findings.push(...known.findings);
      res.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    }

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
  nodeMajor?: number; // chuyển Node.js sang major này qua NodeSource (vd 24)
}

// Đổi major Node.js qua NodeSource: thêm kho node_<major>.x rồi cài gói. Dùng
// khi major hiện tại đã EOL (không bao giờ có bản vá) hoặc node đang lấy từ
// kho Ubuntu/Debian chưa kịp vá. Đổi major có thể làm hỏng native module đã
// build — vì vậy hỏi xác nhận và nhắc deploy lại.
async function switchNodeMajor(major: number, yes: boolean, feed: NodeFeed): Promise<boolean> {
  if (![22, 24, 26].includes(major)) die(`--node-major chỉ nhận nhánh LTS còn hỗ trợ: 22, 24, 26 (nhận được: ${major}).`);
  if (nodeLifecycle(`${major}.0.0`, new Date(), feed.eol).eol) die(`Node.js ${major}.x đã hết hỗ trợ — chọn nhánh LTS mới hơn.`);
  const cur = nodeStatus(feed);
  info(`Chuyển Node.js ${cur?.version ?? "(chưa cài)"} -> ${major}.x LTS qua NodeSource.`);
  const majorChanges = cur !== undefined && parseInt(cur.version.slice(1), 10) !== major;
  if (majorChanges) {
    warn("Đổi MAJOR có thể làm hỏng native module (bcrypt, sharp, better-sqlite3...) đã build cho Node cũ — cần deploy lại app sau đó.");
  }
  if (!(await confirm(`Tiến hành cài Node.js ${major}.x?`, yes))) {
    info("Đã huỷ. Không thay đổi gì.");
    return false;
  }
  runCmd("bash", ["-c", `curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash -`]);
  waitForAptLocks();
  runCmd("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "-y", "-o", `DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_S}`, "install", "nodejs"]);
  const after = nodeStatus(feed);
  ok(`Node.js hiện tại: ${after?.version ?? "?"} (${after?.execPath ?? "?"})`);
  if (after && after.affected.length > 0) {
    danger(`Vẫn còn dính ${nodeAffectedLabel(after.affected)} — kho NodeSource có thể chưa phát hành bản vá, thử lại sau ít giờ.`);
  }
  if (majorChanges) {
    warn("Đã đổi major Node.js: chạy lại 'napp app deploy <domain>' / 'napp service deploy <name>' để build lại native module.");
  }
  return true;
}

export async function cmdDoctorUpgrade(opts: DoctorUpgradeOptions): Promise<void> {
  requireRoot();
  if (!hasApt()) die("Không tìm thấy apt-get — lệnh này chỉ hỗ trợ Ubuntu/Debian.");

  section("Cài bản vá cho hệ thống");

  const { feed, warnings } = await loadNodeFeed({ online: true });
  for (const w of warnings) warn(w);

  if (opts.nodeMajor !== undefined) {
    if (await switchNodeMajor(opts.nodeMajor, opts.yes, feed)) await restartStaleUnits(opts);
    return;
  }

  info("Đang làm mới chỉ mục gói (apt-get update)...");
  aptGet(["update", "-qq"]);

  // Gói nodejs của NodeSource KHÔNG nằm trong kho '-security' nên bộ lọc "chỉ
  // bản vá bảo mật" sẽ bỏ sót nó — đúng gói cần vá nhất. Coi nó là bản vá bảo
  // mật khi Node đang chạy dính CVE đã biết.
  const node = nodeStatus(feed);
  const nodeVulnerable = Boolean(node && node.affected.length > 0 && node.pkgVersion);
  const pending = pendingUpdates().map((p) => (p.pkg === "nodejs" && nodeVulnerable ? { ...p, security: true } : p));
  if (node && node.affected.length > 0 && !pending.some((p) => p.pkg === "nodejs")) {
    console.log();
    danger(`Node.js ${node.version} dính ${nodeAffectedLabel(node.affected)} nhưng kho apt KHÔNG có bản nodejs mới hơn.`);
    printNodeFixHint(node);
    console.log();
  }
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

  if (selected.some((p) => p.pkg === "nodejs")) {
    const after = nodeStatus(feed);
    if (after && after.affected.length === 0) ok(`Node.js đã lên ${after.version} — hết các lỗ hổng đã biết.`);
    else if (after) danger(`Node.js ${after.version} vẫn dính ${nodeAffectedLabel(after.affected)}.`);
  }

  await restartStaleUnits(opts);
}

// Restart các unit còn nạp thư viện/binary cũ (kể cả /usr/bin/node sau khi vá
// nodejs — app vẫn chạy node CŨ trong RAM tới khi restart), rồi nhắc reboot.
async function restartStaleUnits(opts: DoctorUpgradeOptions): Promise<void> {
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
  const report = await cmdDoctorSystem({ refresh: opts.refresh });
  const deps = await cmdDoctorDeps({ audit: opts.audit, deep: opts.deep });

  section("Tóm tắt");
  const secCount = report?.security.length ?? 0;
  const nodeCves = report?.node?.affected ?? [];
  const depCritical = deps.reduce((n, r) => n + r.findings.filter((f) => f.severity === "critical" || f.severity === "high").length, 0);

  if (secCount === 0 && depCritical === 0 && nodeCves.length === 0) {
    ok("Không phát hiện rủi ro bảo mật nào cần xử lý ngay.");
  } else {
    if (secCount > 0) danger(`${secCount} gói hệ thống có bản vá bảo mật đang chờ  ->  sudo napp doctor upgrade`);
    if (nodeCves.length > 0) danger(`Node.js ${report!.node!.version} dính ${nodeAffectedLabel(nodeCves)}  ->  sudo napp doctor upgrade`);
    if (depCritical > 0) danger(`${depCritical} rủi ro mức CAO/NGHIÊM TRỌNG trong dependencies  ->  xem phần hướng dẫn xử lý ở trên`);
  }
  console.log();
  info("Nên chạy 'sudo napp doctor' định kỳ (hàng tuần) — và luôn 'napp update' để có bảng CVE mới nhất.");
}

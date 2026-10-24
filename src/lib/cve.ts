// --------------------------------------------------------------------------
// Bảng CVE ĐÁNG CHÚ Ý của các thành phần napp cài đặt.
//
// Chỉ so số phiên bản upstream là KHÔNG ĐỦ, và đó là cái bẫy lớn nhất ở đây:
// Ubuntu/Debian vá ngược (backport) mà GIỮ NGUYÊN số upstream, nên nginx
// "1.24.0" đã vá và chưa vá nhìn giống hệt nhau. Một công cụ chỉ so số sẽ báo
// động mãi không tắt kể cả sau khi người dùng đã nâng cấp — vô dụng và còn tệ
// hơn không có, vì người dùng sẽ học cách phớt lờ nó.
//
// Vì vậy assessNginxCves() (cuối file) kết luận dựa trên BẰNG CHỨNG đọc được
// ngay trên máy — changelog của gói đã cài, cờ biên dịch, cấu hình đang chạy —
// và chỉ báo động khi không chứng minh được là đã xử lý.
//
// GIỚI HẠN PHẢI BIẾT khi đọc kết quả:
//   1. Bảng này TĨNH, nằm trong binary napp -> chỉ mới tới thời điểm phát hành
//      bản napp bạn đang chạy. Luôn chạy 'napp update' để có bảng mới nhất.
//   2. Chỉ liệt kê CVE có ảnh hưởng thực tế tới cấu hình reverse-proxy điển
//      hình, không phải toàn bộ lịch sử CVE của phần mềm.
//   3. "KHÔNG DÍNH" dựa trên cấu hình TẠI THỜI ĐIỂM QUÉT — đổi cấu hình (bật
//      HTTP/2, thêm resolver...) thì phải quét lại.
// --------------------------------------------------------------------------

export type CveSeverity = "critical" | "high" | "medium" | "low";

export interface CveEntry {
  id: string;
  // Các mã CVE RIÊNG LẺ để dò trong changelog gói (id ở trên có thể gộp nhiều
  // mã cho gọn khi hiển thị, vd "CVE-2022-41741/41742").
  cveIds: string[];
  severity: CveSeverity;
  // Phiên bản đã vá, mỗi nhánh một mục (nginx phát hành song song stable/mainline).
  // Quy tắc: lấy mục có <major.minor> LỚN NHẤT mà <= phiên bản đang cài; nếu
  // không có mục nào <= (bản cài cũ hơn mọi nhánh đã vá) -> coi là dính.
  fixedIn: string[];
  summary: string;
  // Điều kiện để thực sự bị ảnh hưởng (module/cấu hình cụ thể) — in kèm để
  // người dùng tự loại trừ, tránh hoảng loạn không cần thiết.
  condition?: string;
  // Điều kiện KIỂM ĐƯỢC TỰ ĐỘNG: cờ biên dịch (đọc từ 'nginx -V') và directive
  // trong cấu hình (đọc từ 'nginx -T'). Thiếu điều kiện -> lỗ hổng KHÔNG với
  // tới được trên máy này.
  requiresBuildFlag?: RegExp;
  requiresDirective?: RegExp;
  notApplicableWhy?: string;
}

// 'nginx -T' in nguyên văn file cấu hình như người dùng viết, KHÔNG định dạng
// lại — nên directive có thể nằm giữa dòng ('server { listen 443 ssl http2; }').
// Vì vậy KHÔNG neo vào đầu dòng mà chỉ đòi một ranh giới directive đứng trước
// (đầu chuỗi, khoảng trắng, ';' hoặc '{'). Neo sai sẽ kết luận nhầm "không
// dính" — chiều sai NGUY HIỂM nhất của công cụ bảo mật.
const DIRECTIVE_START = "(?:^|[;{}\\s])";
const directive = (body: string) => new RegExp(DIRECTIVE_START + body, "m");

// Bật HTTP/2, cả hai cú pháp: 'listen 443 ssl http2;' (cũ) và 'http2 on;'
// (từ nginx 1.25.1).
const HTTP2_ON = directive("(?:listen\\s[^;]*\\bhttp2\\b|http2\\s+on\\s*;)");

export const NGINX_CVES: CveEntry[] = [
  {
    id: "CVE-2025-23419",
    cveIds: ["CVE-2025-23419"],
    severity: "medium",
    fixedIn: ["1.26.3", "1.27.4"],
    summary: "TLS session resumption dùng chung giữa các server block — có thể vượt qua xác thực client certificate (mTLS).",
    condition: "Chỉ ảnh hưởng khi dùng client certificate (ssl_verify_client) trên nhiều server block.",
    requiresDirective: directive("ssl_verify_client\\s+(?!off\\b)"),
    notApplicableWhy: "cấu hình không bật xác thực client certificate (ssl_verify_client)",
  },
  {
    id: "CVE-2024-7347",
    cveIds: ["CVE-2024-7347"],
    severity: "high",
    fixedIn: ["1.26.2", "1.27.1"],
    summary: "Đọc bộ nhớ ngoài vùng trong ngx_http_mp4_module — file mp4 dựng riêng làm nginx worker crash.",
    condition: "Chỉ ảnh hưởng khi bật module mp4 (directive 'mp4' trong cấu hình).",
    requiresBuildFlag: /--with-http_mp4_module/,
    requiresDirective: directive("mp4\\s*;"),
    notApplicableWhy: "cấu hình không dùng directive 'mp4'",
  },
  {
    id: "CVE-2023-44487",
    cveIds: ["CVE-2023-44487"],
    severity: "high",
    fixedIn: ["1.25.3"],
    summary: "HTTP/2 Rapid Reset — client mở/huỷ stream liên tục làm cạn tài nguyên máy chủ (DoS).",
    condition: "Ảnh hưởng khi bật HTTP/2. Giảm thiểu: keepalive_requests + limit_req (napp tune đã đặt giới hạn cơ bản).",
    requiresDirective: HTTP2_ON,
    notApplicableWhy: "cấu hình không bật HTTP/2",
  },
  {
    id: "CVE-2022-41741/41742",
    cveIds: ["CVE-2022-41741", "CVE-2022-41742"],
    severity: "high",
    fixedIn: ["1.22.1", "1.23.2"],
    summary: "Ghi/đọc ngoài vùng nhớ trong ngx_http_mp4_module — có thể crash worker hoặc lộ bộ nhớ.",
    condition: "Chỉ ảnh hưởng khi bật module mp4.",
    requiresBuildFlag: /--with-http_mp4_module/,
    requiresDirective: directive("mp4\\s*;"),
    notApplicableWhy: "cấu hình không dùng directive 'mp4'",
  },
  {
    id: "CVE-2021-23017",
    cveIds: ["CVE-2021-23017"],
    severity: "critical",
    fixedIn: ["1.20.1", "1.21.0"],
    summary: "Lỗi off-by-one trong resolver — kẻ tấn công giả mạo phản hồi DNS có thể ghi đè bộ nhớ, dẫn tới THỰC THI MÃ TỪ XA.",
    condition: "Chỉ ảnh hưởng khi cấu hình có directive 'resolver'.",
    requiresDirective: directive("resolver\\s+\\S"),
    notApplicableWhy: "cấu hình không có directive 'resolver'",
  },
  {
    id: "CVE-2019-20372",
    cveIds: ["CVE-2019-20372"],
    severity: "high",
    fixedIn: ["1.17.7"],
    summary: "Request smuggling qua error_page — chèn được request thứ hai vào kết nối tới backend.",
    condition: "Ảnh hưởng khi dùng error_page kèm chuyển hướng nội bộ.",
    requiresDirective: directive("error_page\\s+\\S"),
    notApplicableWhy: "cấu hình không dùng error_page",
  },
  {
    id: "CVE-2019-9511/9513",
    cveIds: ["CVE-2019-9511", "CVE-2019-9513"],
    severity: "high",
    fixedIn: ["1.16.1", "1.17.3"],
    summary: "Nhóm lỗ hổng DoS của HTTP/2 (Data Dribble, Ping Flood, Resource Loop).",
    condition: "Ảnh hưởng khi bật HTTP/2.",
    requiresDirective: HTTP2_ON,
    notApplicableWhy: "cấu hình không bật HTTP/2",
  },
];

// So sánh phiên bản kiểu số-chấm (1.24.10 > 1.24.9). Ký tự đuôi không phải số
// (vd '1.25.3-1ubuntu2') bị bỏ qua — phần so sánh chỉ lấy các nhóm số.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Phiên bản upstream có nằm trong dải ẢNH HƯỞNG của CVE không (theo quy tắc
// nhánh mô tả ở CveEntry.fixedIn).
export function isAffected(version: string, cve: CveEntry): boolean {
  const branchOf = (v: string) => v.split(".").slice(0, 2).join(".");
  const vBranch = branchOf(version);
  let best: string | undefined;
  for (const fixed of cve.fixedIn) {
    if (compareVersions(branchOf(fixed), vBranch) <= 0) {
      if (!best || compareVersions(branchOf(fixed), branchOf(best)) > 0) best = fixed;
    }
  }
  if (!best) return true; // cũ hơn mọi nhánh đã vá
  return compareVersions(version, best) < 0;
}

export function nginxCvesFor(version: string): CveEntry[] {
  return NGINX_CVES.filter((c) => isAffected(version, c));
}

// --- Kết luận có BẰNG CHỨNG cho từng CVE ----------------------------------
// So số phiên bản upstream là chưa đủ (backport giữ nguyên số). Ở đây dùng ba
// nguồn bằng chứng đọc được ngay trên máy, theo thứ tự tin cậy giảm dần:
//   1. changelog của GÓI đã cài (/usr/share/doc/<pkg>/changelog.Debian.gz):
//      bản vá backport LUÔN ghi mã CVE vào đây -> tìm thấy = đã vá, chắc chắn.
//   2. cờ biên dịch ('nginx -V'): module không được build vào thì lỗ hổng của
//      module đó không tồn tại trên máy này.
//   3. cấu hình đang chạy ('nginx -T'): thiếu directive kích hoạt thì đoạn mã
//      chứa lỗ hổng không bao giờ được gọi tới.
export type CveVerdict = "patched" | "not-applicable" | "affected";

export interface CveAssessment {
  cve: CveEntry;
  verdict: CveVerdict;
  reason: string;
}

export interface NginxEvidence {
  changelog?: string; // nội dung changelog gói đã cài
  buildFlags?: string; // output 'nginx -V'
  config?: string; // output 'nginx -T' (cấu hình gộp)
}

export function assessNginxCves(version: string, ev: NginxEvidence): CveAssessment[] {
  return nginxCvesFor(version).map((cve) => {
    if (ev.changelog) {
      const hit = cve.cveIds.find((id) => ev.changelog!.includes(id));
      if (hit) {
        return { cve, verdict: "patched" as const, reason: `changelog của gói đã cài có ghi ${hit} (bản vá backport)` };
      }
    }
    if (cve.requiresBuildFlag && ev.buildFlags && !cve.requiresBuildFlag.test(ev.buildFlags)) {
      return { cve, verdict: "not-applicable" as const, reason: "nginx không được biên dịch kèm module chứa lỗ hổng" };
    }
    if (cve.requiresDirective && ev.config && !cve.requiresDirective.test(ev.config)) {
      return { cve, verdict: "not-applicable" as const, reason: cve.notApplicableWhy ?? "cấu hình không kích hoạt phần chứa lỗ hổng" };
    }
    const missing: string[] = [];
    if (!ev.changelog) missing.push("changelog gói");
    if (cve.requiresDirective && !ev.config) missing.push("cấu hình đang chạy");
    return {
      cve,
      verdict: "affected" as const,
      reason: missing.length ? `chưa đối chiếu được ${missing.join(" + ")}` : "không tìm thấy bằng chứng đã vá, và điều kiện kích hoạt CÓ trên máy này",
    };
  });
}

// --- Node.js: dữ liệu lỗ hổng ---------------------------------------------
// Bảng tĩnh trong binary có một điểm chết: lỗi công bố HÔM NAY chỉ tới được
// server sau khi phát hành napp mới VÀ server chạy 'napp update' — với lỗi RCE
// như CVE-2026-111497 thì quá chậm. Vì vậy dữ liệu Node lấy TRỰC TUYẾN từ ba
// nguồn chính thức (tải + cache ở lib/nodefeed.ts), bảng tĩnh chỉ còn là dự
// phòng khi máy không ra được mạng:
//   1. nodejs/security-wg  vuln/core/index.json — CVE có tên + dải semver
//      dính/đã vá. Đầy đủ nhưng CHẬM: đợt vá 10/2026 tới 24/10 vẫn chưa có.
//   2. nodejs.org/dist/index.json — mỗi bản phát hành có cờ 'security'. Có
//      ngay khi phát hành, không kèm mã CVE -> tín hiệu NHANH NHẤT: "nhánh của
//      bạn đã có bản vá bảo mật mới hơn bản đang chạy".
//   3. nodejs/Release schedule.json — ngày EOL của từng nhánh.
// Nguyên tắc: thiếu nguồn nào thì kết luận dựa trên phần còn lại + bảng tĩnh,
// KHÔNG BAO GIỜ coi "không tải được" là "an toàn".

export interface NodeAdvisory {
  id: string;
  cveIds: string[];
  severity: CveSeverity;
  vulnerable: string; // dải semver kiểu security-wg: "22.x || 24.x"
  patched: string; // "^22.23.4 || ^24.22.1"
  summary: string;
  condition?: string;
  ref?: string;
}

export interface NodeSecurityRelease {
  version: string; // "v24.22.1"
  date: string;
}

export interface NodeFeed {
  advisories: NodeAdvisory[];
  securityReleases?: NodeSecurityRelease[]; // undefined = không có dữ liệu (đừng suy ra "không có bản vá")
  eol?: Record<number, string>; // major -> ngày hết hỗ trợ
  source: string; // mô tả nguồn để in cho người dùng
}

// Dự phòng offline. Ghi theo cùng định dạng security-wg để đi chung một đường.
// Bản EOL (20.x, 23.x, 25.x) cố ý nằm trong 'vulnerable': Node.js tuyên bố
// "End-of-Life versions are always affected when a security release occurs".
export const NODE_ADVISORIES_BUILTIN: NodeAdvisory[] = [
  {
    id: "CVE-2026-111497",
    cveIds: ["CVE-2026-111497"],
    severity: "critical",
    vulnerable: "<26.12.1",
    patched: "^22.23.4 || ^24.22.1 || ^26.12.1",
    summary:
      "Ghi ngoài vùng nhớ trong bộ giải nén Brotli (node:zlib) — dữ liệu nén Brotli do kẻ tấn công gửi tới có thể " +
      "dẫn tới THỰC THI MÃ TỪ XA hoặc lộ bộ nhớ (CVSS 9.8).",
    condition:
      "Dính khi app giải nén Brotli từ nguồn không tin cậy: body request 'Content-Encoding: br' (body-parser 2 / " +
      "Express 5 tự giải nén), fetch()/undici gọi ra ngoài (tự giải nén phản hồi br), zlib.brotliDecompress*. " +
      "Rất khó tự loại trừ cho mọi dependency — coi như dính.",
    ref: "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases",
  },
  {
    id: "CVE-2026-105482/105483/106069",
    cveIds: ["CVE-2026-105482", "CVE-2026-105483", "CVE-2026-106069"],
    severity: "high",
    vulnerable: "<26.12.1",
    patched: "^22.23.4 || ^24.22.1 || ^26.12.1",
    summary:
      "dns.resolve*() cắt tên miền tại byte NUL, TLS nhận nhầm địa chỉ IP viết kiểu lạ (chữ số toàn chiều rộng, " +
      "số 0 ở đầu) — có thể kết nối/xác thực chứng chỉ nhầm đích.",
    condition: "Dính khi app kết nối tới host/URL do người dùng cung cấp (webhook, proxy, crawler...).",
    ref: "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases",
  },
];

// Bổ sung lời giải thích "khi nào thực sự dính" cho CVE nổi bật — dữ liệu
// security-wg chỉ có mô tả kỹ thuật tiếng Anh.
const NODE_NOTES: Record<string, Pick<NodeAdvisory, "summary" | "condition">> = Object.fromEntries(
  NODE_ADVISORIES_BUILTIN.flatMap((a) => a.cveIds.map((id) => [id, { summary: a.summary, condition: a.condition }]))
);

// Ngày EOL dự phòng (nguồn: nodejs.org/en/about/previous-releases).
const NODE_EOL_BUILTIN: Record<number, string> = {
  14: "2023-04-30",
  16: "2023-09-11",
  18: "2025-04-30",
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
  26: "2029-04-30",
};

export const NODE_FEED_BUILTIN: NodeFeed = {
  advisories: NODE_ADVISORIES_BUILTIN,
  eol: NODE_EOL_BUILTIN,
  source: "bảng có sẵn trong napp (offline)",
};

// --- semver tối giản ---------------------------------------------------------
// Đủ cho cú pháp security-wg THỰC SỰ dùng (đã đối chiếu toàn bộ 194 mục):
// "N.x", "N.N.x", "N", "N.N.N", "^N.N.N", ">=N.N.N", "<N.N.N", "<=", ">", "<=N" — có
// thể có khoảng trắng sau toán tử (">= 24.1.0"), khoảng trắng = AND, "||" = OR.
// Gặp cú pháp lạ thì NÉM LỖI để mục đó bị bỏ qua có báo, thay vì đoán bừa.
type Ver = [number, number, number];

function parseVer(s: string): Ver {
  const m = s.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`phiên bản không hợp lệ: ${s}`);
  return [+m[1]!, +m[2]!, +m[3]!];
}

function cmp(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

function comparatorMatches(v: Ver, tok: string): boolean {
  if (tok === "*" || tok === "x") return true;
  let m = tok.match(/^(\d+)(?:\.x(?:\.x)?)?$/);
  if (m) return v[0] === +m[1]!;
  m = tok.match(/^(\d+)\.(\d+)(?:\.x)?$/);
  if (m) return v[0] === +m[1]! && v[1] === +m[2]!;
  m = tok.match(/^\^(\d+\.\d+\.\d+)$/);
  if (m) {
    const lo = parseVer(m[1]!);
    return cmp(v, lo) >= 0 && v[0] === lo[0];
  }
  // Phiên bản viết thiếu kèm toán tử ("<= 10", ">=10.9") — security-wg có dùng.
  // Theo semver: "<=10" = "<11.0.0", ">10" = ">=11.0.0", ">=10" = ">=10.0.0".
  m = tok.match(/^(>=|<=|>|<)(\d+)(?:\.(\d+))?$/);
  if (m) {
    const [maj, min] = [+m[2]!, m[3] === undefined ? undefined : +m[3]];
    const lo: Ver = [maj, min ?? 0, 0];
    const next: Ver = min === undefined ? [maj + 1, 0, 0] : [maj, min + 1, 0];
    switch (m[1]) {
      case ">=": return cmp(v, lo) >= 0;
      case ">": return cmp(v, next) >= 0;
      case "<=": return cmp(v, next) < 0;
      default: return cmp(v, lo) < 0;
    }
  }
  m = tok.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
  if (m) {
    const c = cmp(v, parseVer(m[2]!));
    switch (m[1]) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      default: return c === 0;
    }
  }
  throw new Error(`cú pháp dải phiên bản không hỗ trợ: ${tok}`);
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  return range.split("||").some((alt) => {
    const toks = alt.trim().replace(/(>=|<=|>|<|=)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (toks.length === 0) throw new Error(`dải phiên bản rỗng: "${range}"`);
    return toks.every((t) => comparatorMatches(v, t));
  });
}

// Bản vá nhỏ nhất CÙNG MAJOR theo dải 'patched' ("^24.22.1" hoặc ">=24.22.1").
function patchedFloorFor(major: number, patched: string): string | undefined {
  for (const alt of patched.split("||")) {
    const m = alt.trim().match(/^(?:\^|>=\s*)(\d+)\.(\d+)\.(\d+)$/);
    if (m && +m[1]! === major) return `${m[1]}.${m[2]}.${m[3]}`;
  }
  return undefined;
}

// --- kiểm dữ liệu tải về ----------------------------------------------------
// Dữ liệu từ mạng là DỮ LIỆU, không phải mã: kiểm chặt từng trường. Một mục
// lệch định dạng thì bỏ mục đó; cả tệp lệch (trang lỗi HTML, JSON lạ) thì ném
// lỗi để lớp trên lùi về cache/bảng tĩnh.
const CVE_ID = /^CVE-\d{4}-\d{4,}$/;
const SEVERITIES: Record<string, CveSeverity> = { critical: "critical", high: "high", medium: "medium", low: "low", unknown: "medium" };

export function parseSecurityWg(json: unknown): { advisories: NodeAdvisory[]; skipped: number } {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("security-wg: không phải object");
  const advisories: NodeAdvisory[] = [];
  let skipped = 0;
  for (const [key, raw] of Object.entries(json as Record<string, unknown>)) {
    const e = raw as Record<string, unknown>;
    try {
      if (!e || typeof e !== "object") throw new Error("mục không phải object");
      const cve = Array.isArray(e.cve) ? e.cve.filter((x): x is string => typeof x === "string" && CVE_ID.test(x)) : [];
      if (typeof e.vulnerable !== "string" || typeof e.patched !== "string") throw new Error("thiếu dải phiên bản");
      // Kiểm cú pháp NGAY (với một phiên bản bất kỳ) để mục lỗi bị loại ở đây,
      // không làm hỏng lúc đánh giá.
      satisfies("0.0.0", e.vulnerable);
      satisfies("0.0.0", e.patched);
      const envs = Array.isArray(e.affectedEnvironments) ? e.affectedEnvironments : ["all"];
      if (!envs.includes("all") && !envs.includes("linux")) continue; // napp chỉ chạy Linux
      const note = cve.map((id) => NODE_NOTES[id]).find(Boolean);
      const desc = typeof e.description === "string" ? e.description.slice(0, 300) : "";
      advisories.push({
        id: cve.length ? cve.join("/") : `nodejs-sec-${key}`,
        cveIds: cve,
        severity: SEVERITIES[typeof e.severity === "string" ? e.severity : "unknown"] ?? "medium",
        vulnerable: e.vulnerable,
        patched: e.patched,
        summary: note?.summary ?? (desc || "(không có mô tả)"),
        condition: note?.condition,
        ref: typeof e.ref === "string" && /^https:\/\//.test(e.ref) ? e.ref : undefined,
      });
    } catch {
      skipped++;
    }
  }
  if (advisories.length === 0) throw new Error("security-wg: không có mục hợp lệ nào");
  return { advisories, skipped };
}

export function parseDistIndex(json: unknown): NodeSecurityRelease[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error("dist/index.json: không phải mảng");
  const out: NodeSecurityRelease[] = [];
  for (const r of json as Record<string, unknown>[]) {
    if (r && r.security === true && typeof r.version === "string" && /^v\d+\.\d+\.\d+$/.test(r.version)) {
      out.push({ version: r.version, date: typeof r.date === "string" ? r.date.slice(0, 10) : "" });
    }
  }
  if (out.length === 0) throw new Error("dist/index.json: không có bản phát hành bảo mật nào — dữ liệu đáng ngờ");
  return out;
}

export function parseSchedule(json: unknown): Record<number, string> {
  if (!json || typeof json !== "object") throw new Error("schedule.json: không phải object");
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(json as Record<string, { end?: unknown }>)) {
    const m = k.match(/^v(\d+)$/);
    if (m && v && typeof v.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.end)) out[+m[1]!] = v.end;
  }
  if (Object.keys(out).length === 0) throw new Error("schedule.json: không có nhánh nào");
  return out;
}

// Gộp nguồn trực tuyến với bảng tĩnh: cùng mã CVE thì lấy bản trực tuyến
// (mới hơn); mục tĩnh mà nguồn trực tuyến CHƯA có thì giữ lại — chính là
// trường hợp security-wg chậm chân so với thông báo vá.
export function mergeAdvisories(online: NodeAdvisory[], builtin: NodeAdvisory[] = NODE_ADVISORIES_BUILTIN): NodeAdvisory[] {
  const known = new Set(online.flatMap((a) => a.cveIds));
  return [...online, ...builtin.filter((b) => !b.cveIds.some((id) => known.has(id)))];
}

// --- Vòng đời Node.js ------------------------------------------------------
// Bản đã hết hạn hỗ trợ (EOL) KHÔNG còn nhận bản vá bảo mật nào nữa — đây là
// rủi ro lớn hơn nhiều so với một CVE lẻ, vì nó vĩnh viễn không được vá.
export interface NodeLifecycle {
  major: number;
  lts: boolean;
  eolDate?: string;
  eol: boolean;
}

export function nodeLifecycle(version: string, now = new Date(), eolTable: Record<number, string> = NODE_EOL_BUILTIN): NodeLifecycle {
  const major = nodeMajorOf(version);
  const lts = major % 2 === 0; // Node chỉ đưa bản CHẴN lên LTS
  const eolDate = eolTable[major] ?? NODE_EOL_BUILTIN[major];
  // Bản lẻ (19/21/23/...) không bao giờ là LTS: hết hỗ trợ ~6 tháng sau khi ra,
  // coi như EOL trên máy chủ production dù không có trong bảng.
  const eol = eolDate ? new Date(eolDate).getTime() < now.getTime() : !lts;
  return { major, lts, eolDate, eol };
}

function nodeMajorOf(version: string): number {
  return parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
}

// --- Đánh giá -----------------------------------------------------------------
export interface NodeAssessment {
  advisory: NodeAdvisory;
  verdict: "patched" | "affected";
  reason: string;
  fixedIn?: string; // bản vá cùng major; undefined = nhánh không có bản vá
}

export interface NodeAssessOptions {
  // changelog.Debian của gói nodejs — CHỈ truyền khi node đang chạy đúng là
  // binary của gói đó, nếu không sẽ kết luận "đã vá" nhầm cho một node khác.
  changelog?: string;
  // Gói của bản phân phối (vá ngược GIỮ NGUYÊN số): khi đó "nhánh đã có bản
  // phát hành bảo mật mới hơn" KHÔNG chứng minh được là dính -> bỏ tín hiệu đó,
  // để kho '-security' của apt lo.
  distroBackport?: boolean;
}

export function assessNode(version: string, feed: NodeFeed, opts: NodeAssessOptions = {}): NodeAssessment[] {
  const v = version.replace(/^v/, "");
  const major = nodeMajorOf(v);
  const out: NodeAssessment[] = [];
  for (const adv of feed.advisories) {
    if (!satisfies(v, adv.vulnerable) || satisfies(v, adv.patched)) continue;
    const hit = opts.changelog ? adv.cveIds.find((id) => opts.changelog!.includes(id)) : undefined;
    const fixedIn = patchedFloorFor(major, adv.patched);
    out.push(
      hit
        ? { advisory: adv, verdict: "patched", reason: `changelog của gói nodejs có ghi ${hit} (bản vá backport)`, fixedIn }
        : {
            advisory: adv,
            verdict: "affected",
            reason: fixedIn ? `Node ${v} cũ hơn bản vá ${fixedIn} của nhánh ${major}.x` : `nhánh ${major}.x không có bản vá (đã hết hỗ trợ)`,
            fixedIn,
          }
    );
  }

  // Tín hiệu nhanh: nhánh này đã có bản phát hành BẢO MẬT mới hơn bản đang
  // chạy, mà bản vá đó cao hơn mọi bản vá CVE có tên ở trên -> có lỗ hổng mà
  // dữ liệu CVE chưa kịp ghi. Chỉ thêm khi nó nói được điều MỚI.
  if (feed.securityReleases && !opts.distroBackport) {
    const newer = feed.securityReleases
      .filter((r) => nodeMajorOf(r.version) === major && cmp(parseVer(r.version), parseVer(v)) > 0)
      .sort((a, b) => cmp(parseVer(b.version), parseVer(a.version)));
    const latest = newer[0];
    const knownFix = out
      .filter((a) => a.verdict === "affected" && a.fixedIn)
      .reduce<string | undefined>((m, a) => (!m || compareVersions(a.fixedIn!, m) > 0 ? a.fixedIn : m), undefined);
    if (latest && (!knownFix || compareVersions(latest.version.slice(1), knownFix) > 0)) {
      out.push({
        advisory: {
          id: `Node.js ${latest.version}`,
          cveIds: [],
          severity: "high",
          vulnerable: "*",
          patched: `>=${latest.version.slice(1)}`,
          summary:
            `Nhánh ${major}.x đã phát hành bản vá BẢO MẬT ${latest.version}${latest.date ? ` (${latest.date})` : ""} ` +
            `mới hơn bản đang chạy${newer.length > 1 ? ` (${newer.length} bản bảo mật kể từ bản của bạn)` : ""} — ` +
            `chi tiết CVE có thể chưa được ghi vào dữ liệu lỗ hổng.`,
          ref: "https://nodejs.org/en/blog/vulnerability",
        },
        verdict: "affected",
        reason: `Node ${v} < ${latest.version.slice(1)}`,
        fixedIn: latest.version.slice(1),
      });
    }
  }

  const rank: Record<CveSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => rank[a.advisory.severity] - rank[b.advisory.severity]);
}

// Bản cùng major cần lên để hết MỌI lỗ hổng đang dính; undefined = có lỗ hổng
// mà nhánh này không có bản vá -> chỉ còn cách lên major khác.
export function nodeFixedVersion(assessments: NodeAssessment[]): string | undefined {
  let need: string | undefined;
  for (const a of assessments.filter((x) => x.verdict === "affected")) {
    if (!a.fixedIn) return undefined;
    if (!need || compareVersions(a.fixedIn, need) > 0) need = a.fixedIn;
  }
  return need;
}

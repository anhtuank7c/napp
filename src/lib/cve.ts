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

export type CveSeverity = "critical" | "high" | "medium";

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

// --- Vòng đời Node.js ------------------------------------------------------
// Bản đã hết hạn hỗ trợ (EOL) KHÔNG còn nhận bản vá bảo mật nào nữa — đây là
// rủi ro lớn hơn nhiều so với một CVE lẻ, vì nó vĩnh viễn không được vá.
// Nguồn: lịch LTS của Node.js (nodejs.org/en/about/previous-releases).
const NODE_EOL: Record<number, string> = {
  14: "2023-04-30",
  16: "2023-09-11",
  18: "2025-04-30",
  20: "2026-04-30",
  22: "2027-04-30",
  24: "2028-04-30",
};

export interface NodeLifecycle {
  major: number;
  lts: boolean;
  eolDate?: string;
  eol: boolean;
}

export function nodeLifecycle(version: string, now = new Date()): NodeLifecycle {
  const major = parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
  const lts = major % 2 === 0; // Node chỉ đưa bản CHẴN lên LTS
  const eolDate = NODE_EOL[major];
  // Bản lẻ (19/21/23/...) không bao giờ là LTS: hết hỗ trợ ~6 tháng sau khi ra,
  // coi như EOL trên máy chủ production dù không có trong bảng.
  const eol = eolDate ? new Date(eolDate).getTime() < now.getTime() : !lts;
  return { major, lts, eolDate, eol };
}

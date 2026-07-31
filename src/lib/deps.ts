import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { execCaptureAs } from "./exec";
import type { PackageManager } from "./state";

// --------------------------------------------------------------------------
// Quét rủi ro CHUỖI CUNG ỨNG (dependency chain attack) cho mã nguồn app/service.
//
// Kiểu tấn công cần chặn: kẻ xấu chiếm tài khoản npm của một package (hoặc
// publish package tên na ná), đẩy một bản vá nhỏ có mã độc; app của bạn dùng
// dải phiên bản mở ("^1.2.3") và KHÔNG có lockfile nên lần deploy kế tiếp tự
// kéo bản độc về, rồi script postinstall chạy ngay với quyền user của app.
//
// Vì vậy các dấu hiệu được kiểm ở đây tập trung vào ĐƯỜNG VÀO của mã lạ:
//   - lockfile (cài đặt có tất định không)
//   - cách ghim phiên bản, dependency trỏ thẳng git/URL (không có integrity)
//   - script cài đặt (preinstall/install/postinstall) trong cây node_modules
//   - lỗ hổng đã công bố (audit của chính package manager)
//   - tên gần giống package phổ biến (typosquat)
//   - bản phát hành còn quá mới (chỉ với --deep, cần mạng)
// --------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export interface DepFinding {
  severity: Severity;
  title: string;
  detail: string;
  fix: string;
}

export interface ProjectTarget {
  label: string; // vd: "app web api.example.com"
  dir: string;
  user: string;
  pm: PackageManager;
}

export interface ProjectScanResult {
  target: ProjectTarget;
  findings: DepFinding[];
  packageCount: number;
  skipped?: string; // lý do bỏ qua (không có package.json, ...)
}

const LOCKFILES: Record<PackageManager, string[]> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

const ALL_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

// Danh sách package phổ biến để dò TYPOSQUAT (tên sai một ký tự so với hàng
// thật). Cố tình ngắn và chỉ gồm tên hay bị nhái — mục đích là bắt trường hợp
// rõ ràng, không phải quét toàn bộ registry.
const POPULAR_PACKAGES = [
  "express", "react", "react-dom", "lodash", "axios", "moment", "chalk", "commander", "dotenv", "debug",
  "request", "async", "bluebird", "mongoose", "mysql2", "pg", "redis", "ioredis", "socket.io", "ws",
  "jsonwebtoken", "bcrypt", "bcryptjs", "passport", "cors", "helmet", "body-parser", "cookie-parser",
  "multer", "nodemailer", "winston", "pino", "morgan", "joi", "yup", "zod", "uuid", "nanoid",
  "typescript", "eslint", "prettier", "jest", "mocha", "chai", "vite", "webpack", "rollup", "esbuild",
  "next", "nuxt", "svelte", "vue", "angular", "tailwindcss", "postcss", "sharp", "puppeteer", "playwright",
  "prisma", "sequelize", "knex", "typeorm", "graphql", "apollo-server", "fastify", "koa", "hapi", "nest",
];

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2; // chỉ cần biết "có <= 1 hay không"
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

export interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
  installScripts: string[]; // tên các script cài đặt được khai báo
}

// Duyệt cây node_modules để lấy danh sách package đã cài. Có GIỚI HẠN số lượng
// (mặc định 8000) để không treo trên dự án khổng lồ. Hỗ trợ cả bố cục pnpm
// (kho thật nằm trong node_modules/.pnpm, ngoài chỉ là symlink).
export function collectInstalledPackages(root: string, cap = 8000): InstalledPackage[] {
  const out: InstalledPackage[] = [];
  const visited = new Set<string>();
  // pnpm để package thật trong node_modules/.pnpm rồi symlink ra ngoài, nên
  // cùng một thư mục package đi tới được bằng hai đường -> phải khử trùng lặp
  // theo đường dẫn THẬT, nếu không số liệu và danh sách script sẽ bị nhân đôi.
  const seenPackages = new Set<string>();

  const addPackage = (dir: string) => {
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (seenPackages.has(realDir)) return;
    seenPackages.add(realDir);
    const pkg = readJson(`${dir}/package.json`);
    if (!pkg || typeof pkg.name !== "string") return;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const installScripts = ["preinstall", "install", "postinstall", "prepare"].filter(
      (s) => typeof scripts[s] === "string" && (scripts[s] as string).trim() !== ""
    );
    out.push({
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : "?",
      dir,
      installScripts,
    });
  };

  const walk = (nmDir: string, depth: number) => {
    if (out.length >= cap || depth > 4) return;
    let real: string;
    try {
      real = realpathSync(nmDir);
    } catch {
      return;
    }
    if (visited.has(real)) return; // symlink vòng (pnpm/workspace) — chỉ đi một lần
    visited.add(real);
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
    } catch {
      return;
    }
    for (const ent of entries as unknown as { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]) {
      if (out.length >= cap) return;
      const name = ent.name;
      if (name === ".bin") continue;
      const full = `${nmDir}/${name}`;
      if (name === ".pnpm") {
        // Kho thật của pnpm: .pnpm/<pkg>@<ver>/node_modules/<pkg>
        let stores: string[] = [];
        try {
          stores = readdirSync(full);
        } catch {
          continue;
        }
        for (const s of stores) {
          if (out.length >= cap) return;
          walk(`${full}/${s}/node_modules`, depth + 1);
        }
        continue;
      }
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        let scoped: string[] = [];
        try {
          scoped = readdirSync(full);
        } catch {
          continue;
        }
        for (const s of scoped) {
          if (out.length >= cap) return;
          addPackage(`${full}/${s}`);
          if (existsSync(`${full}/${s}/node_modules`)) walk(`${full}/${s}/node_modules`, depth + 1);
        }
        continue;
      }
      addPackage(full);
      if (existsSync(`${full}/node_modules`)) walk(`${full}/node_modules`, depth + 1);
    }
  };

  walk(`${root}/node_modules`, 0);
  return out;
}

// --- audit của chính package manager --------------------------------------

export interface AuditResult {
  counts: Partial<Record<Severity, number>>;
  top: { name: string; severity: Severity; title: string; fixAvailable: boolean }[];
  error?: string;
}

function auditCommand(target: ProjectTarget): { cmd: string; args: string[] } | undefined {
  switch (target.pm) {
    case "npm":
      return { cmd: "npm", args: ["audit", "--json", "--omit=dev"] };
    case "pnpm":
      return { cmd: "pnpm", args: ["audit", "--json", "--prod"] };
    case "yarn": {
      // yarn classic (1.x) dùng 'yarn audit'; yarn berry (>=2) đổi thành
      // 'yarn npm audit' — gọi sai lệnh thì berry báo "Unknown command".
      const v = execCaptureAs(target.user, "yarn", ["--version"], { cwd: target.dir, timeoutMs: 30_000 }).stdout.trim();
      const major = parseInt(v.split(".")[0] ?? "1", 10);
      return major >= 2
        ? { cmd: "yarn", args: ["npm", "audit", "--json", "--environment", "production"] }
        : { cmd: "yarn", args: ["audit", "--json", "--groups", "dependencies"] };
    }
    case "bun":
      return { cmd: "bun", args: ["audit", "--json"] };
    default:
      return undefined;
  }
}

function normalizeSeverity(s: unknown): Severity {
  const v = String(s ?? "").toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "moderate" || v === "medium") return "medium";
  if (v === "low") return "low";
  return "info";
}

// Gộp nhiều định dạng output audit khác nhau về một dạng chung:
//   - npm v2 / pnpm mới : { vulnerabilities: { <pkg>: {severity, via[], fixAvailable} }, metadata }
//   - npm v1 / yarn berry: { advisories: { <id>: {module_name, severity, title} } }
//   - yarn classic       : NDJSON, mỗi dòng {type:"auditAdvisory", data:{advisory:{...}}}
export function parseAuditOutput(raw: string): AuditResult {
  const counts: Partial<Record<Severity, number>> = {};
  const top: AuditResult["top"] = [];
  const bump = (s: Severity) => {
    counts[s] = (counts[s] ?? 0) + 1;
  };

  const ingestV2 = (vulns: Record<string, any>) => {
    for (const [name, v] of Object.entries(vulns)) {
      const sev = normalizeSeverity(v?.severity);
      bump(sev);
      const via = Array.isArray(v?.via) ? v.via.find((x: any) => x && typeof x === "object") : undefined;
      top.push({
        name,
        severity: sev,
        title: String(via?.title ?? v?.title ?? "lỗ hổng đã công bố"),
        fixAvailable: Boolean(v?.fixAvailable),
      });
    }
  };
  const ingestAdvisories = (advs: Record<string, any>) => {
    for (const a of Object.values(advs)) {
      const sev = normalizeSeverity(a?.severity);
      bump(sev);
      top.push({
        name: String(a?.module_name ?? a?.name ?? "?"),
        severity: sev,
        title: String(a?.title ?? "lỗ hổng đã công bố"),
        fixAvailable: Boolean(a?.patched_versions && a.patched_versions !== "<0.0.0"),
      });
    }
  };

  const text = raw.trim();
  if (!text) return { counts, top, error: "audit không trả về dữ liệu" };

  try {
    const doc = JSON.parse(text) as any;
    if (doc && typeof doc === "object") {
      if (doc.vulnerabilities && !Array.isArray(doc.vulnerabilities) && typeof doc.vulnerabilities === "object") {
        // npm v2: metadata.vulnerabilities là bảng ĐẾM, không phải danh sách.
        const looksLikeCounts = Object.values(doc.vulnerabilities).every((v) => typeof v === "number");
        if (!looksLikeCounts) ingestV2(doc.vulnerabilities);
      }
      if (doc.advisories && typeof doc.advisories === "object") ingestAdvisories(doc.advisories);
    }
  } catch {
    // NDJSON (yarn classic) — mỗi dòng một JSON độc lập.
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const doc = JSON.parse(t) as any;
        if (doc?.type === "auditAdvisory" && doc?.data?.advisory) {
          ingestAdvisories({ x: doc.data.advisory });
        }
      } catch {
        /* bỏ qua dòng hỏng */
      }
    }
  }

  if (top.length === 0 && Object.keys(counts).length === 0) {
    return { counts, top };
  }
  top.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { counts, top };
}

export function runAudit(target: ProjectTarget): AuditResult {
  const spec = auditCommand(target);
  if (!spec) return { counts: {}, top: [], error: `chưa hỗ trợ audit cho '${target.pm}'` };
  const res = execCaptureAs(target.user, spec.cmd, spec.args, {
    cwd: target.dir,
    timeoutMs: 180_000,
    // Tắt màu/tiến trình để output chỉ còn JSON thuần.
    env: { NO_COLOR: "1", NPM_CONFIG_FUND: "false", NPM_CONFIG_AUDIT_LEVEL: "info", CI: "1" },
  });
  // Các trình audit trả mã KHÁC 0 khi TÌM THẤY lỗ hổng — không phải lỗi chạy.
  const parsed = parseAuditOutput(res.stdout);
  if (parsed.top.length === 0 && !res.stdout.trim()) {
    const err = (res.stderr || "").split("\n").filter(Boolean).slice(0, 2).join(" ");
    return { counts: {}, top: [], error: err || `không chạy được '${spec.cmd} ${spec.args.join(" ")}' (mã ${res.code})` };
  }
  return parsed;
}

// --- kiểm tra tĩnh trên package.json / node_modules ------------------------

export function scanProject(target: ProjectTarget, opts: { audit: boolean } = { audit: true }): ProjectScanResult {
  const findings: DepFinding[] = [];
  const dir = target.dir;

  if (!existsSync(`${dir}/package.json`)) {
    return { target, findings, packageCount: 0, skipped: "không có package.json" };
  }
  const pkg = readJson(`${dir}/package.json`);
  if (!pkg) {
    findings.push({
      severity: "medium",
      title: "package.json không đọc được",
      detail: `${dir}/package.json không phải JSON hợp lệ — không quét được khai báo dependency.`,
      fix: "Sửa lại cú pháp package.json rồi quét lại.",
    });
    return { target, findings, packageCount: 0 };
  }

  const deps: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.optionalDependencies as Record<string, string>) ?? {}),
  };
  const devDeps = (pkg.devDependencies as Record<string, string>) ?? {};

  // 1. Lockfile — điều kiện tiên quyết để cài đặt TẤT ĐỊNH.
  const expected = LOCKFILES[target.pm] ?? [];
  const hasOwnLock = expected.some((f) => existsSync(`${dir}/${f}`));
  const foreignLocks = ALL_LOCKFILES.filter((f) => !expected.includes(f) && existsSync(`${dir}/${f}`));
  if (!hasOwnLock) {
    findings.push({
      severity: "high",
      title: `Thiếu lockfile cho ${target.pm} (${expected.join(" / ")})`,
      detail:
        "Không có lockfile nghĩa là mỗi lần deploy sẽ giải lại dải phiên bản và có thể kéo về bản MỚI vừa publish. " +
        "Đây chính là đường vào của tấn công chuỗi cung ứng: bản độc phát hành lúc 2h sáng sẽ tự chui vào lần deploy kế tiếp.",
      fix:
        `Trên máy dev: chạy '${target.pm} install' để sinh lockfile, commit vào repo, rồi 'napp app deploy' / 'napp service deploy'.\n` +
        "    Lockfile phải được COMMIT — đây là bản ghi chính xác từng phiên bản + hash toàn vẹn của toàn bộ cây phụ thuộc.",
    });
  }
  if (foreignLocks.length > 0) {
    findings.push({
      severity: "low",
      title: `Có lockfile của trình quản lý gói khác: ${foreignLocks.join(", ")}`,
      detail: `Dự án đang cài bằng ${target.pm} nhưng repo còn lockfile của trình khác — dễ gây hiểu nhầm và cài ra hai cây phụ thuộc khác nhau giữa dev và server.`,
      fix: `Xoá lockfile thừa khỏi repo, chỉ giữ ${expected[0] ?? "lockfile đúng trình"}.`,
    });
  }

  // 2. Cách khai báo phiên bản — chỗ quyết định "được phép kéo bản mới nào".
  const wildcard: string[] = [];
  const remote: string[] = [];
  const loose: string[] = [];
  for (const [name, spec] of Object.entries({ ...deps, ...devDeps })) {
    if (typeof spec !== "string") continue;
    const s = spec.trim();
    if (/^(\*|x|latest|)$/i.test(s)) wildcard.push(`${name}@${s || "(rỗng)"}`);
    else if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:)/i.test(s)) remote.push(`${name} -> ${s}`);
    else if (/^[\^~]|^>=|\s-\s|\|\|/.test(s)) loose.push(`${name}@${s}`);
  }
  if (wildcard.length > 0) {
    findings.push({
      severity: "high",
      title: `${wildcard.length} dependency không ghim phiên bản ('*' / 'latest')`,
      detail: `Luôn lấy bản mới nhất tại thời điểm cài: ${wildcard.slice(0, 8).join(", ")}${wildcard.length > 8 ? ", ..." : ""}`,
      fix: "Đổi sang phiên bản cụ thể (vd \"4.19.2\") hoặc dải hẹp (\"^4.19.2\") KÈM lockfile đã commit.",
    });
  }
  if (remote.length > 0) {
    findings.push({
      severity: "high",
      title: `${remote.length} dependency trỏ thẳng tới git/URL`,
      detail:
        `Không đi qua registry nên KHÔNG có hash toàn vẹn: chủ repo (hoặc ai chiếm được) đổi nội dung branch/tag là mã đổi theo mà lockfile không phát hiện.\n` +
        `    ${remote.slice(0, 6).join("\n    ")}`,
      fix: "Ghim theo commit SHA đầy đủ (vd 'github:user/repo#<sha40>') thay vì branch/tag, hoặc publish nội bộ lên registry riêng.",
    });
  }
  if (loose.length > 0 && !hasOwnLock) {
    findings.push({
      severity: "medium",
      title: `${loose.length} dependency dùng dải phiên bản mở mà KHÔNG có lockfile`,
      detail: `Ví dụ: ${loose.slice(0, 6).join(", ")}${loose.length > 6 ? ", ..." : ""}`,
      fix: "Commit lockfile (xem mục thiếu lockfile ở trên) — có lockfile thì dải mở không còn nguy hiểm.",
    });
  }

  // 3. Script cài đặt trong cây node_modules — nơi mã lạ được THỰC THI ngay
  //    lúc cài, trước cả khi ứng dụng chạy.
  const installed = collectInstalledPackages(dir);
  const withScripts = installed.filter((p) => p.installScripts.some((s) => s !== "prepare"));
  if (withScripts.length > 0) {
    const list = withScripts.slice(0, 10).map((p) => `${p.name}@${p.version} (${p.installScripts.join(",")})`);
    findings.push({
      severity: withScripts.length > 15 ? "medium" : "low",
      title: `${withScripts.length} package chạy script khi cài đặt`,
      detail:
        "Script preinstall/install/postinstall chạy với quyền user của app NGAY khi cài — là bước thực thi đầu tiên của mọi package bị chiếm. " +
        `Nhiều package hợp lệ cũng dùng (biên dịch native, tải binary), nên đây là danh sách CẦN RÀ, không phải kết luận:\n    ${list.join("\n    ")}` +
        (withScripts.length > 10 ? `\n    ... và ${withScripts.length - 10} package nữa` : ""),
      fix:
        "Rà từng cái xem có đúng là package cần biên dịch/tải binary không.\n" +
        "    Muốn chặn hẳn: đặt install-cmd có '--ignore-scripts' (npm/pnpm/yarn/bun đều hỗ trợ), vd\n" +
        `      napp app create ... --install-cmd 'npm ci --omit=dev --ignore-scripts'\n` +
        "    Lưu ý: package cần biên dịch native (bcrypt, sharp, better-sqlite3...) sẽ hỏng nếu chặn — hãy thay bằng bản thuần JS hoặc build sẵn.",
    });
  }

  // 4. Typosquat — tên gần giống package phổ biến.
  const suspicious: string[] = [];
  for (const name of Object.keys(deps)) {
    if (name.startsWith("@") || name.length < 4) continue;
    for (const popular of POPULAR_PACKAGES) {
      if (name === popular) break;
      if (Math.abs(name.length - popular.length) <= 1 && levenshtein(name, popular) === 1) {
        suspicious.push(`${name} (giống '${popular}')`);
        break;
      }
    }
  }
  if (suspicious.length > 0) {
    findings.push({
      severity: "high",
      title: `${suspicious.length} tên package gần giống package phổ biến (nghi typosquat)`,
      detail: `Kẻ tấn công publish tên sai một ký tự để ăn theo lỗi gõ phím: ${suspicious.join(", ")}`,
      fix: "Đối chiếu tên với trang chính thức của thư viện. Nếu gõ nhầm: gỡ package đó, cài lại đúng tên, đổi mọi secret mà app dùng (mã lạ đã có thể đọc .env).",
    });
  }

  // 5. .npmrc chứa token — rò rỉ là mất luôn quyền publish của tổ chức.
  const npmrc = `${dir}/.npmrc`;
  if (existsSync(npmrc)) {
    let content = "";
    try {
      content = readFileSync(npmrc, "utf8");
    } catch {
      /* không đọc được thì bỏ qua */
    }
    if (/_auth(Token)?\s*=/.test(content)) {
      let mode = 0;
      try {
        mode = statSync(npmrc).mode & 0o777;
      } catch {
        /* giữ 0 */
      }
      const tooOpen = (mode & 0o077) !== 0;
      findings.push({
        severity: tooOpen ? "high" : "low",
        title: `.npmrc chứa token registry${tooOpen ? ` và quyền quá rộng (${mode.toString(8)})` : ""}`,
        detail: `${npmrc} có _authToken. Token này thường có quyền ĐỌC (đôi khi cả PUBLISH) trên registry riêng của bạn.`,
        fix: tooOpen
          ? `sudo chmod 600 ${npmrc} && sudo chown ${target.user}:${target.user} ${npmrc}`
          : "Cân nhắc dùng token chỉ-đọc riêng cho máy chủ, và xoay vòng định kỳ.",
      });
    }
  }

  // 6. audit của package manager (cần mạng).
  if (opts.audit) {
    const audit = runAudit(target);
    if (audit.error) {
      findings.push({
        severity: "info",
        title: "Không chạy được audit lỗ hổng",
        detail: audit.error,
        fix: `Chạy tay để xem chi tiết: sudo -u ${target.user} bash -lc 'cd ${target.dir} && ${target.pm} audit'`,
      });
    } else {
      const bad = audit.top.filter((v) => v.severity === "critical" || v.severity === "high");
      const total = Object.values(audit.counts).reduce((a, b) => a + b, 0);
      if (bad.length > 0) {
        findings.push({
          severity: bad.some((v) => v.severity === "critical") ? "critical" : "high",
          title: `${bad.length} lỗ hổng nghiêm trọng/cao trong dependencies (tổng ${total})`,
          detail: bad
            .slice(0, 8)
            .map((v) => `${v.name} [${v.severity}] ${v.title}${v.fixAvailable ? " — CÓ bản vá" : " — chưa có bản vá"}`)
            .join("\n    "),
          fix:
            `Trên máy dev: '${target.pm} audit' để xem chi tiết, '${target.pm === "npm" ? "npm audit fix" : `${target.pm} update`}' để nâng cấp, commit lockfile mới rồi deploy lại.\n` +
            "    Package chưa có bản vá: cân nhắc thay thư viện khác hoặc khoá đường đi tới đoạn mã bị ảnh hưởng.",
        });
      } else if (total > 0) {
        findings.push({
          severity: "low",
          title: `${total} lỗ hổng mức thấp/trung bình trong dependencies`,
          detail: audit.top.slice(0, 5).map((v) => `${v.name} [${v.severity}] ${v.title}`).join("\n    "),
          fix: `Nâng cấp khi tiện: '${target.pm} audit' trên máy dev, commit lockfile mới rồi deploy.`,
        });
      }
    }
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { target, findings, packageCount: installed.length };
}

// --- kiểm tra sâu: tuổi của bản phát hành (cần mạng) -----------------------
// Bản vừa publish vài giờ/ngày là dấu hiệu đáng ngờ NHẤT của tấn công chuỗi
// cung ứng: gói bị chiếm thường được phát hiện và gỡ trong vòng 24-72h, nên
// nếu server vừa kéo về một bản mới tinh thì đáng dừng lại kiểm tra.
export interface FreshRelease {
  name: string;
  installedVersion: string;
  lastPublishISO: string;
  ageDays: number;
  isLatest: boolean;
}

export async function checkFreshReleases(
  target: ProjectTarget,
  opts: { maxPackages?: number; freshDays?: number; timeoutMs?: number } = {}
): Promise<{ fresh: FreshRelease[]; checked: number; error?: string }> {
  const maxPackages = opts.maxPackages ?? 40;
  const freshDays = opts.freshDays ?? 14;
  const pkg = readJson(`${target.dir}/package.json`);
  if (!pkg) return { fresh: [], checked: 0, error: "không đọc được package.json" };
  const direct = Object.keys((pkg.dependencies as Record<string, string>) ?? {});
  if (direct.length === 0) return { fresh: [], checked: 0 };

  // Chỉ tra dependency TRỰC TIẾP và có giới hạn: mỗi lần tra là một request tới
  // registry, không nên biến việc quét thành một trận tải hàng trăm MB.
  const names = direct.slice(0, maxPackages);
  const installedVersion = (name: string): string | undefined => {
    const p = readJson(`${target.dir}/node_modules/${name}/package.json`);
    return typeof p?.version === "string" ? p.version : undefined;
  };

  const fresh: FreshRelease[] = [];
  let checked = 0;
  let firstError: string | undefined;
  const CONCURRENCY = 6;
  let cursor = 0;

  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++]!;
      const version = installedVersion(name);
      if (!version) continue;
      try {
        // Packument RÚT GỌN (accept header dưới đây) nhỏ hơn nhiều bản đầy đủ:
        // bỏ README/lịch sử, chỉ giữ dist-tags + metadata cài đặt.
        const res = await fetch(`https://registry.npmjs.org/${name.replace(/\//g, "%2f")}`, {
          headers: { accept: "application/vnd.npm.install-v1+json" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        if (!res.ok) {
          firstError ??= `registry trả ${res.status} cho '${name}'`;
          continue;
        }
        const doc = (await res.json()) as { modified?: string; time?: Record<string, string>; "dist-tags"?: Record<string, string> };
        checked++;
        const latest = doc["dist-tags"]?.latest;
        // time[<version>] chính xác hơn nhưng chỉ có ở packument đầy đủ; bản rút
        // gọn chỉ có 'modified' = lần publish gần nhất của CẢ package.
        const stamp = doc.time?.[version] ?? doc.modified;
        if (!stamp) continue;
        const ageDays = (Date.now() - new Date(stamp).getTime()) / 86_400_000;
        if (ageDays <= freshDays) {
          fresh.push({
            name,
            installedVersion: version,
            lastPublishISO: stamp,
            ageDays: Math.max(0, Math.round(ageDays * 10) / 10),
            isLatest: latest === version,
          });
        }
      } catch (e) {
        firstError ??= (e as Error).message;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  fresh.sort((a, b) => a.ageDays - b.ageDays);
  return { fresh, checked, error: checked === 0 ? firstError : undefined };
}

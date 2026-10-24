import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFile, state } from "./exec";
import type { DepFinding, ProjectTarget, Severity } from "./deps";

// --------------------------------------------------------------------------
// Lỗ hổng + MÃ ĐỘC đã biết trong dependencies PRODUCTION, tra trên OSV.dev.
//
// Vì sao OSV thay cho 'npm/pnpm/yarn audit' (audit vẫn là đường dự phòng):
//   1. Có cơ sở dữ liệu GÓI ĐỘC của OpenSSF (mã MAL-...): gói bị chiếm tài khoản
//      / typosquat đã bị gỡ khỏi registry nhưng VẪN NẰM trong node_modules của
//      server. Audit của package manager thường không báo loại này.
//   2. Tra đúng phiên bản ĐANG CÀI trong node_modules (thứ đang chạy), không
//      phải thứ lockfile nói sẽ cài.
//   3. Không phải chạy package manager của app (đọc .npmrc, .pnpmfile.cjs...
//      của repo) — chỉ đọc file package.json.
//
// "Chỉ production": dev dependency (jest, eslint, typescript...) có trong
// node_modules vì napp phải build, nhưng không chạy khi app phục vụ request.
// Báo lỗ hổng của chúng ngang hàng với thư viện production là cách nhanh nhất
// để người dùng học phớt lờ cả bản báo cáo. Ở đây đi từ 'dependencies' của
// package.json theo ĐÚNG thuật toán resolve của Node — gói nào không nằm trên
// đường đó thì không được nạp lúc chạy.
// RIÊNG mã độc thì soi CẢ dev dependency: script postinstall chạy lúc cài, bất
// kể gói đó là dev hay prod.
// --------------------------------------------------------------------------

const OSV_API = "https://api.osv.dev/v1";
const BATCH = 1000; // giới hạn của /v1/querybatch
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DETAIL_FETCH = 400; // số mã lỗ hổng tối đa tra chi tiết mỗi lần quét
const CACHE_PATH = "/var/cache/napp/osv-vulns.json";
const CACHE_MAX = 5000;

export interface ResolvedPackage {
  name: string;
  version: string;
  prod: boolean;
  via?: string; // dependency trực tiếp trong package.json kéo gói này vào
}

function readPkg(dir: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

// Thuật toán resolve của Node: từ thư mục THẬT của gói đi ngược lên, thử
// <cha>/node_modules/<tên> ở mỗi cấp, bỏ qua các cấp tên 'node_modules'. Chạy
// đúng cho cả npm/yarn/bun (cây hoisted) lẫn pnpm (.pnpm/<x>/node_modules/).
function resolveFrom(fromDir: string, name: string, stopAt: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    if (basename(dir) !== "node_modules") {
      const cand = join(dir, "node_modules", name);
      if (existsSync(join(cand, "package.json"))) {
        try {
          return realpathSync(cand);
        } catch {
          return undefined;
        }
      }
    }
    if (dir === stopAt) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/**
 * Mọi gói trong node_modules, đánh dấu gói nào thuộc tập PRODUCTION. undefined
 * khi không có node_modules (chưa cài / Yarn PnP) — caller lùi về audit.
 */
export function resolveInstalledPackages(root: string, cap = 20_000): ResolvedPackage[] | undefined {
  if (!existsSync(join(root, "node_modules"))) return undefined;
  const rootReal = realpathSync(root);
  const rootPkg = readPkg(root);
  if (!rootPkg) return undefined;

  const seen = new Map<string, ResolvedPackage>(); // realDir -> gói
  const queue: { dir: string; via: string }[] = [];
  const enqueue = (fromDir: string, deps: Record<string, unknown> | undefined, via: (name: string) => string) => {
    for (const name of Object.keys(deps ?? {})) {
      const real = resolveFrom(fromDir, name, rootReal);
      if (real && !seen.has(real)) {
        const pkg = readPkg(real);
        if (!pkg || typeof pkg.name !== "string") continue;
        seen.set(real, { name: pkg.name, version: String(pkg.version ?? "?"), prod: true, via: via(name) });
        queue.push({ dir: real, via: via(name) });
      }
    }
  };

  enqueue(rootReal, { ...rootPkg.dependencies, ...rootPkg.optionalDependencies, ...rootPkg.peerDependencies }, (n) => n);
  while (queue.length > 0 && seen.size < cap) {
    const { dir, via } = queue.shift()!;
    const pkg = readPkg(dir) ?? {};
    // peerDependencies: do gói khác cung cấp, nhưng gói này GỌI tới lúc chạy.
    enqueue(dir, { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }, () => via);
  }

  const out = [...seen.values()];
  // Phần còn lại của node_modules = dev (hoặc gói mồ côi) — chỉ dùng để soi mã độc.
  const prodKeys = new Set(out.map((p) => `${p.name}@${p.version}`));
  for (const p of collectAll(join(rootReal, "node_modules"), cap - out.length)) {
    if (!prodKeys.has(`${p.name}@${p.version}`)) {
      prodKeys.add(`${p.name}@${p.version}`);
      out.push({ ...p, prod: false });
    }
  }
  return out;
}

// Liệt kê thô mọi gói có trong cây node_modules (kể cả .pnpm), để soi mã độc.
function collectAll(nm: string, cap: number): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  const visited = new Set<string>();
  const visitPkg = (dir: string) => {
    const pkg = readPkg(dir);
    if (pkg && typeof pkg.name === "string") out.push({ name: pkg.name, version: String(pkg.version ?? "?") });
    if (existsSync(join(dir, "node_modules"))) walk(join(dir, "node_modules"), 0);
  };
  const walk = (dir: string, depth: number) => {
    if (out.length >= cap || depth > 6) return;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= cap) return;
      if (n === ".bin") continue;
      if (n === ".pnpm") {
        let stores: string[] = [];
        try {
          stores = readdirSync(join(dir, n));
        } catch {
          continue;
        }
        for (const st of stores) walk(join(dir, n, st, "node_modules"), depth + 1);
      } else if (n.startsWith("@")) {
        let scoped: string[] = [];
        try {
          scoped = readdirSync(join(dir, n));
        } catch {
          continue;
        }
        for (const sc of scoped) visitPkg(join(dir, n, sc));
      } else if (!n.startsWith(".")) {
        visitPkg(join(dir, n));
      }
    }
  };
  walk(nm, 0);
  return out;
}

// --- semver đủ dùng cho phiên bản npm (kể cả -beta.1) ---------------------
export function compareSemver(a: string, b: string): number {
  const [ma, pa] = splitPre(a);
  const [mb, pb] = splitPre(b);
  for (let i = 0; i < 3; i++) if ((ma[i] ?? 0) !== (mb[i] ?? 0)) return (ma[i] ?? 0) < (mb[i] ?? 0) ? -1 : 1;
  if (!pa && !pb) return 0;
  if (!pa) return 1; // bản chính thức > bản tiền phát hành
  if (!pb) return -1;
  const xa = pa.split(".");
  const xb = pb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]!) ? +xa[i]! : NaN;
    const nb = /^\d+$/.test(xb[i]!) ? +xb[i]! : NaN;
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na < nb ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i]! < xb[i]! ? -1 : 1;
  }
  return 0;
}

function splitPre(v: string): [number[], string | undefined] {
  const clean = v.replace(/^v/, "").split("+")[0]!;
  const i = clean.indexOf("-");
  const main = (i >= 0 ? clean.slice(0, i) : clean).split(".").map((x) => parseInt(x, 10) || 0);
  return [main, i >= 0 ? clean.slice(i + 1) : undefined];
}

// --- chi tiết lỗ hổng (gọn, có cache) ---------------------------------------
interface VulnInfo {
  modified: string;
  summary: string;
  aliases: string[];
  severity: Severity;
  malicious: boolean;
  // Chỉ phần npm của 'affected', để tính bản vá cho đúng gói.
  ranges: { name: string; events: Record<string, string>[] }[];
}

function compactVuln(j: any): VulnInfo {
  const id = String(j?.id ?? "");
  // Gói độc: mã MAL- (OpenSSF), hoặc advisory GitHub gắn CWE-506 "Embedded
  // Malicious Code" (GHSA "Malicious Package in ..." — có loại không kèm MAL-).
  const cwes: unknown[] = Array.isArray(j?.database_specific?.cwe_ids) ? j.database_specific.cwe_ids : [];
  const malicious = id.startsWith("MAL-") || cwes.includes("CWE-506");
  const db = String(j?.database_specific?.severity ?? "").toUpperCase();
  const severity: Severity = malicious
    ? "critical"
    : db === "CRITICAL"
      ? "critical"
      : db === "HIGH"
        ? "high"
        : db === "MODERATE" || db === "MEDIUM"
          ? "medium"
          : db === "LOW"
            ? "low"
            : "medium"; // không có phân loại: không hạ thấp, cũng không thổi phồng
  const ranges: VulnInfo["ranges"] = [];
  for (const a of Array.isArray(j?.affected) ? j.affected : []) {
    if (a?.package?.ecosystem !== "npm" || typeof a?.package?.name !== "string") continue;
    for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
      if (r?.type !== "SEMVER" || !Array.isArray(r.events)) continue;
      ranges.push({ name: a.package.name, events: r.events.filter((e: unknown) => e && typeof e === "object").slice(0, 50) });
    }
  }
  return {
    modified: String(j?.modified ?? ""),
    summary: String(j?.summary ?? j?.details ?? "").split("\n")[0]!.slice(0, 200),
    aliases: (Array.isArray(j?.aliases) ? j.aliases : []).filter((x: unknown) => typeof x === "string").slice(0, 5),
    severity,
    malicious,
    ranges,
  };
}

// Bản vá của ĐÚNG gói này cho ĐÚNG phiên bản đang cài; undefined = chưa có bản vá.
export function fixedVersionFor(info: VulnInfo, name: string, version: string): string | undefined {
  let best: string | undefined;
  for (const r of info.ranges.filter((x) => x.name === name)) {
    let introduced: string | undefined;
    for (const e of r.events) {
      if (e.introduced !== undefined) introduced = e.introduced;
      else if (e.fixed !== undefined && introduced !== undefined) {
        const inRange = (introduced === "0" || compareSemver(version, introduced) >= 0) && compareSemver(version, e.fixed) < 0;
        if (inRange && (!best || compareSemver(e.fixed, best) < 0)) best = e.fixed;
        introduced = undefined;
      }
    }
  }
  return best;
}

type Cache = Record<string, VulnInfo>;

function readCache(): Cache {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

function writeCache(c: Cache): void {
  if (state.dryRun || process.platform !== "linux" || process.getuid?.() !== 0) return;
  const entries = Object.entries(c);
  const trimmed = entries.length > CACHE_MAX ? Object.fromEntries(entries.slice(-CACHE_MAX)) : c;
  try {
    writeFile(CACHE_PATH, JSON.stringify(trimmed), 0o644);
  } catch {
    /* cache chỉ để đỡ gọi mạng */
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return readJson(res);
}

async function readJson(res: Response): Promise<any> {
  if (!res.ok) throw new Error(`OSV trả HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("phản hồi OSV quá lớn");
  return JSON.parse(buf.toString("utf8"));
}

// --- quét -------------------------------------------------------------------
export interface OsvHit {
  name: string;
  version: string;
  prod: boolean;
  via?: string;
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  malicious: boolean;
  fixed?: string;
}

export interface OsvScanResult {
  hits: OsvHit[];
  prodCount: number;
  devCount: number;
  truncated?: boolean; // quá nhiều mã lỗ hổng, chỉ tra chi tiết một phần
}

/** Ném lỗi khi không quét được (mạng, OSV lỗi) — caller lùi về audit. */
export async function osvScan(pkgs: ResolvedPackage[]): Promise<OsvScanResult> {
  const queryable = pkgs.filter((p) => p.version !== "?");
  const ids: { pkg: ResolvedPackage; id: string; modified: string }[] = [];
  for (let i = 0; i < queryable.length; i += BATCH) {
    const chunk = queryable.slice(i, i + BATCH);
    const doc = await postJson(`${OSV_API}/querybatch`, {
      queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })),
    });
    const results = Array.isArray(doc?.results) ? doc.results : undefined;
    if (!results || results.length !== chunk.length) throw new Error("phản hồi OSV sai định dạng");
    results.forEach((r: any, k: number) => {
      for (const v of Array.isArray(r?.vulns) ? r.vulns : []) {
        if (typeof v?.id === "string" && /^[A-Z]+-[\w.-]+$/.test(v.id)) ids.push({ pkg: chunk[k]!, id: v.id, modified: String(v.modified ?? "") });
      }
    });
  }

  // Chi tiết từng mã (mức độ, bản vá) — cache theo 'modified': mã không đổi từ
  // lần trước thì không gọi lại. Lần quét hằng ngày hầu như không tốn request.
  const cache = readCache();
  const unique = [...new Map(ids.map((x) => [x.id, x.modified])).entries()];
  const need = unique.filter(([id, mod]) => cache[id]?.modified !== mod);
  const truncated = need.length > MAX_DETAIL_FETCH;
  const todo = need.slice(0, MAX_DETAIL_FETCH);
  for (let i = 0; i < todo.length; i += 8) {
    await Promise.all(
      todo.slice(i, i + 8).map(async ([id]) => {
        try {
          const res = await fetch(`${OSV_API}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
          cache[id] = compactVuln(await readJson(res));
        } catch {
          /* thiếu chi tiết một mã: vẫn báo với mức "medium", không bỏ sót */
        }
      })
    );
  }
  if (todo.length > 0) writeCache(cache);

  const hits: OsvHit[] = [];
  for (const { pkg, id } of ids) {
    const info = cache[id];
    const malicious = id.startsWith("MAL-") || Boolean(info?.malicious);
    // Dev dependency: CHỈ báo khi là mã độc (lý do ở đầu file).
    if (!pkg.prod && !malicious) continue;
    hits.push({
      name: pkg.name,
      version: pkg.version,
      prod: pkg.prod,
      via: pkg.via,
      id,
      aliases: info?.aliases ?? [],
      summary: info?.summary || "(chưa lấy được mô tả)",
      severity: malicious ? "critical" : (info?.severity ?? "medium"),
      malicious,
      fixed: info ? fixedVersionFor(info, pkg.name, pkg.version) : undefined,
    });
  }
  const rank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  hits.sort((a, b) => Number(b.malicious) - Number(a.malicious) || rank[a.severity] - rank[b.severity]);
  return { hits, prodCount: pkgs.filter((p) => p.prod).length, devCount: pkgs.filter((p) => !p.prod).length, truncated };
}

export function cveLabel(h: OsvHit): string {
  const cve = h.aliases.find((a) => a.startsWith("CVE-"));
  return cve ? `${h.id} / ${cve}` : h.id;
}

// --- kết quả -> phát hiện cho 'doctor deps' --------------------------------
// Cách nâng một gói GIÁN TIẾP (kéo vào bởi dependency khác) theo từng package
// manager: ép phiên bản qua overrides/resolutions khi gói cha chưa kịp nâng.
function overrideHint(pm: ProjectTarget["pm"], name: string, fixed: string): string {
  switch (pm) {
    case "pnpm":
      return `"pnpm": { "overrides": { "${name}": "^${fixed}" } } trong package.json`;
    case "yarn":
      return `"resolutions": { "${name}": "^${fixed}" } trong package.json`;
    default:
      return `"overrides": { "${name}": "^${fixed}" } trong package.json`;
  }
}

function addCmd(pm: ProjectTarget["pm"], spec: string): string {
  return pm === "npm" ? `npm install ${spec}` : `${pm} add ${spec}`;
}

export function osvDepFindings(target: ProjectTarget, r: OsvScanResult): DepFinding[] {
  const findings: DepFinding[] = [];
  const malicious = r.hits.filter((h) => h.malicious);
  // Một gói độc có thể khớp nhiều mã (GHSA + MAL) — gộp theo gói.
  const malPkgs = [...new Map(malicious.map((h) => [`${h.name}@${h.version}`, h])).values()];
  for (const h of malPkgs) {
    findings.push({
      severity: "critical",
      title: `MÃ ĐỘC đã biết trong node_modules: ${h.name}@${h.version} (${h.id})`,
      detail:
        `${h.summary}\n    ` +
        `${h.prod ? `Dependency PRODUCTION${h.via && h.via !== h.name ? `, kéo vào bởi '${h.via}'` : ""}` : "Dependency chỉ dùng khi dev/build — nhưng script cài đặt của nó ĐÃ CHẠY lúc cài"}.`,
      fix:
        `Coi như máy đã bị xâm nhập ở mức user của app (${target.user}):\n` +
        `    1. Gỡ gói khỏi package.json/lockfile trên máy dev (hoặc ghim về bản sạch), deploy lại.\n` +
        `    2. XOAY VÒNG mọi bí mật app đọc được: .env, mật khẩu database, token API, khoá SSH deploy.\n` +
        `    3. Rà tiến trình lạ và crontab của ${target.user}: sudo -u ${target.user} crontab -l; ps -u ${target.user} -f`,
    });
  }

  const vulns = r.hits.filter((h) => !h.malicious);
  const bad = vulns.filter((h) => h.severity === "critical" || h.severity === "high");
  if (bad.length > 0) {
    // Gộp THEO GÓI: người dùng nâng cấp từng gói chứ không vá từng mã lỗ hổng.
    // Bản cần lên = bản vá CAO NHẤT trong mọi lỗ hổng của gói (kể cả mức thấp),
    // để một lần nâng là sạch hẳn — lodash 4.17.15 có mã vá ở 4.17.19, 4.17.21
    // lẫn 4.18.0; khuyên 4.17.21 là để sót.
    const byPkg = [...new Set(bad.map((h) => `${h.name}@${h.version}`))].map((key) => {
      const all = vulns.filter((h) => `${h.name}@${h.version}` === key);
      const high = all.filter((h) => h.severity === "critical" || h.severity === "high");
      const unfixed = all.some((h) => !h.fixed);
      const target = unfixed ? undefined : all.reduce<string | undefined>((m, h) => (!m || compareSemver(h.fixed!, m) > 0 ? h.fixed : m), undefined);
      return { h: high[0]!, high, all, target, unfixed };
    });
    const line = (p: (typeof byPkg)[number]) =>
      `${p.h.name}@${p.h.version} — ${p.high.length} lỗ hổng ${p.high.some((x) => x.severity === "critical") ? "NGHIÊM TRỌNG" : "cao"}` +
      ` (${p.high.slice(0, 3).map(cveLabel).join(", ")}${p.high.length > 3 ? ", …" : ""})` +
      `${p.target ? ` → nâng lên >= ${p.target}` : " → CÓ lỗ hổng CHƯA có bản vá"}${p.h.via && p.h.via !== p.h.name ? ` (kéo vào bởi '${p.h.via}')` : ""}`;
    const fixLines = byPkg
      .filter((p) => p.target)
      .slice(0, 4)
      .map((p) =>
        !p.h.via || p.h.via === p.h.name
          ? addCmd(target.pm, `${p.h.name}@^${p.target}`)
          : `nâng '${p.h.via}' lên bản mới nhất; chưa đủ thì ép ${overrideHint(target.pm, p.h.name, p.target!)}`
      );
    findings.push({
      severity: bad.some((h) => h.severity === "critical") ? "critical" : "high",
      title: `${bad.length} lỗ hổng nghiêm trọng/cao trong ${byPkg.length} dependency production (tổng ${vulns.length} lỗ hổng)`,
      detail: byPkg.slice(0, 8).map(line).join("\n    ") + (byPkg.length > 8 ? `\n    ... và ${byPkg.length - 8} gói nữa` : ""),
      fix:
        (fixLines.length ? `Trên máy dev:\n      ${fixLines.join("\n      ")}\n    rồi commit lockfile, deploy lại.` : "") +
        (byPkg.some((p) => p.unfixed) ? `${fixLines.length ? "\n    " : ""}Gói có lỗ hổng chưa có bản vá: cân nhắc thay thư viện, hoặc chặn dữ liệu không tin cậy đi tới đoạn mã bị ảnh hưởng.` : "") +
        `\n    Chi tiết từng mã: https://osv.dev/vulnerability/<mã>`,
    });
  } else if (vulns.length > 0) {
    findings.push({
      severity: "low",
      title: `${vulns.length} lỗ hổng mức thấp/trung bình trong dependencies production`,
      detail: vulns.slice(0, 5).map((h) => `${h.name}@${h.version} [${h.severity}] ${cveLabel(h)} — ${h.summary}`).join("\n    "),
      fix: "Nâng cấp khi tiện trên máy dev, commit lockfile mới rồi deploy.",
    });
  }
  if (r.truncated) {
    findings.push({
      severity: "info",
      title: "Quá nhiều mã lỗ hổng — mới tra chi tiết một phần",
      detail: "Các mã chưa tra được tạm tính mức 'medium'. Lần quét sau sẽ tra tiếp (có cache).",
      fix: "Chạy lại 'sudo napp doctor deps' sau ít phút.",
    });
  }
  return findings;
}

import { existsSync, readFileSync } from "node:fs";
import { writeFile, state } from "./exec";
import {
  NODE_FEED_BUILTIN,
  mergeAdvisories,
  parseDistIndex,
  parseSchedule,
  parseSecurityWg,
  type NodeAdvisory,
  type NodeFeed,
  type NodeSecurityRelease,
} from "./cve";

// --------------------------------------------------------------------------
// Tải dữ liệu lỗ hổng Node.js trực tuyến (xem phần "Node.js: dữ liệu lỗ hổng"
// trong lib/cve.ts về lý do và ý nghĩa của từng nguồn).
//
// Thứ tự lùi cho TỪNG nguồn, độc lập với nhau:
//   tải được  ->  cache lần tải thành công gần nhất  ->  bảng tĩnh trong napp
// Một nguồn hỏng không kéo theo nguồn khác, và bảng tĩnh luôn được GỘP vào
// danh sách CVE (security-wg chậm chân so với thông báo vá vài tuần).
// --------------------------------------------------------------------------

const SOURCES = {
  advisories: "https://raw.githubusercontent.com/nodejs/security-wg/main/vuln/core/index.json",
  releases: "https://nodejs.org/dist/index.json",
  schedule: "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
} as const;

export const NODE_FEED_CACHE = "/var/cache/napp/node-feed.json";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024; // dist/index.json ~ 1 MB hiện tại; chặn phản hồi bất thường

interface CachedFeed {
  fetchedAt: { advisories?: string; releases?: string; schedule?: string };
  advisories?: NodeAdvisory[];
  securityReleases?: NodeSecurityRelease[];
  eol?: Record<number, string>;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`phản hồi quá lớn (${buf.length} byte)`);
  return JSON.parse(buf.toString("utf8"));
}

function readCache(): CachedFeed | undefined {
  try {
    if (!existsSync(NODE_FEED_CACHE)) return undefined;
    const c = JSON.parse(readFileSync(NODE_FEED_CACHE, "utf8")) as CachedFeed;
    // Cache cũng là dữ liệu từ đĩa — kiểm lại bằng đúng bộ kiểm như lúc tải,
    // một file hỏng/bị sửa thì coi như không có cache.
    if (!c || typeof c !== "object" || !c.fetchedAt) return undefined;
    if (c.advisories && !Array.isArray(c.advisories)) return undefined;
    if (c.securityReleases) parseDistIndex(c.securityReleases.map((r) => ({ ...r, security: true })));
    if (c.eol) parseSchedule(Object.fromEntries(Object.entries(c.eol).map(([k, end]) => [`v${k}`, { end }])));
    return c;
  } catch {
    return undefined;
  }
}

function writeCache(c: CachedFeed): void {
  // Chỉ root ghi được /var/cache; người thường chạy doctor vẫn có dữ liệu mới,
  // chỉ là không lưu lại. Dry-run thì không ghi gì.
  if (state.dryRun || process.platform !== "linux" || process.getuid?.() !== 0) return;
  try {
    writeFile(NODE_FEED_CACHE, JSON.stringify(c), 0o644);
  } catch {
    /* cache chỉ là tiện ích — ghi hỏng không được làm hỏng lần quét */
  }
}

function ageText(iso?: string): string {
  if (!iso) return "?";
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? "dưới 1 giờ trước" : h < 48 ? `${h} giờ trước` : `${Math.floor(h / 24)} ngày trước`;
}

export interface NodeFeedResult {
  feed: NodeFeed;
  warnings: string[]; // nguồn nào phải lùi về cache/bảng tĩnh, vì sao
}

// online=false (vd 'doctor --no-refresh'): không ra mạng, dùng cache + bảng tĩnh.
export async function loadNodeFeed(opts: { online: boolean }): Promise<NodeFeedResult> {
  const cache = readCache();
  const now = new Date().toISOString();
  const warnings: string[] = [];
  const next: CachedFeed = { fetchedAt: { ...(cache?.fetchedAt ?? {}) } };
  const parts: string[] = [];

  const [adv, rel, sch] = opts.online
    ? await Promise.allSettled([fetchJson(SOURCES.advisories), fetchJson(SOURCES.releases), fetchJson(SOURCES.schedule)])
    : ([undefined, undefined, undefined] as const);

  // 1. CVE có tên
  let advisories: NodeAdvisory[] | undefined;
  try {
    if (adv?.status !== "fulfilled") throw adv?.reason ?? new Error("không ra mạng");
    const parsed = parseSecurityWg(adv.value);
    advisories = parsed.advisories;
    next.fetchedAt.advisories = now;
    parts.push(`security-wg ${advisories.length} mục`);
    if (parsed.skipped > 0) warnings.push(`security-wg: bỏ qua ${parsed.skipped} mục sai định dạng.`);
  } catch (e) {
    if (cache?.advisories) {
      advisories = cache.advisories;
      parts.push(`security-wg (cache ${ageText(cache.fetchedAt.advisories)})`);
    }
    if (opts.online) warnings.push(`Không tải được danh sách CVE Node.js (${(e as Error).message}) — dùng ${cache?.advisories ? "cache" : "bảng có sẵn"}.`);
  }
  next.advisories = advisories;

  // 2. Bản phát hành bảo mật
  let securityReleases: NodeSecurityRelease[] | undefined;
  try {
    if (rel?.status !== "fulfilled") throw rel?.reason ?? new Error("không ra mạng");
    securityReleases = parseDistIndex(rel.value);
    next.fetchedAt.releases = now;
    parts.push("dist/index.json");
  } catch (e) {
    if (cache?.securityReleases) {
      securityReleases = cache.securityReleases;
      parts.push(`dist/index.json (cache ${ageText(cache.fetchedAt.releases)})`);
    }
    if (opts.online) warnings.push(`Không tải được danh sách bản phát hành Node.js (${(e as Error).message}).`);
  }
  next.securityReleases = securityReleases;

  // 3. Lịch EOL
  let eol: Record<number, string> | undefined;
  try {
    if (sch?.status !== "fulfilled") throw sch?.reason ?? new Error("không ra mạng");
    eol = parseSchedule(sch.value);
    next.fetchedAt.schedule = now;
    parts.push("lịch EOL");
  } catch {
    eol = cache?.eol; // lịch EOL ít đổi — lùi lặng lẽ, bảng tĩnh vẫn còn
  }
  next.eol = eol;

  if (opts.online && (next.fetchedAt.advisories === now || next.fetchedAt.releases === now || next.fetchedAt.schedule === now)) writeCache(next);

  return {
    feed: {
      advisories: mergeAdvisories(advisories ?? [], NODE_FEED_BUILTIN.advisories),
      securityReleases,
      eol: { ...NODE_FEED_BUILTIN.eol, ...(eol ?? {}) },
      source: parts.length ? `${parts.join(" · ")} + bảng có sẵn` : NODE_FEED_BUILTIN.source,
    },
    warnings,
  };
}


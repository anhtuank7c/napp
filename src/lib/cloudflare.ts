import { die } from "./log";

export interface CloudflareIpRanges {
  ipv4: string[];
  ipv6: string[];
}

// Dải IP dự phòng (bản chụp tại thời điểm viết script) — dùng khi máy chủ
// không có Internet ra ngoài lúc chạy lệnh, hoặc cloudflare.com tạm thời
// không truy cập được. LUÔN ưu tiên tải bản mới nhất trước.
const FALLBACK_IPV4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const FALLBACK_IPV6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

/**
 * Một dải CIDR hợp lệ VÀ không quá rộng. Dải của Cloudflare thực tế là /12-/22
 * (IPv4) và /29-/32 (IPv6); từ chối rộng hơn /8 (v4) hay /16 (v6).
 */
export function isCidr(s: string, family: 4 | 6): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(s);
  if (!m) return false;
  const prefix = Number(m[2]);
  if (family === 4) {
    const parts = m[1]!.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
    return prefix >= 8 && prefix <= 32;
  }
  // IPv6: chỉ chữ số hex và dấu ':', tối đa một '::', 2-8 nhóm.
  const addr = m[1]!;
  if (!/^[0-9a-fA-F:]+$/.test(addr) || (addr.match(/::/g) ?? []).length > 1) return false;
  const groups = addr.split(":").filter((g) => g.length > 0);
  if (groups.length > 8 || groups.some((g) => g.length > 4)) return false;
  if (!addr.includes("::") && groups.length !== 8) return false;
  return prefix >= 16 && prefix <= 128;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
  return res.text();
}

export async function fetchCloudflareIpRanges(): Promise<CloudflareIpRanges> {
  try {
    const [v4, v6] = await Promise.all([fetchText("https://www.cloudflare.com/ips-v4"), fetchText("https://www.cloudflare.com/ips-v6")]);
    const ipv4 = v4.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const ipv6 = v6.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (ipv4.length === 0 || ipv6.length === 0) throw new Error("Danh sách IP trả về rỗng");
    // Mỗi dòng đi thẳng vào 'set_real_ip_from ...;' của nginx. Một dòng lạ (trang
    // lỗi HTML, proxy chen vào, phản hồi bị giả) là chèn được cấu hình nginx; một
    // dải quá rộng (0.0.0.0/0) là nginx tin header IP do BẤT KỲ AI gửi -> kẻ tấn
    // công tự nhận IP tuỳ ý, qua mặt fail2ban và giới hạn tốc độ. Sai một dòng là
    // bỏ cả danh sách, dùng bản dự phòng.
    const bad = [...ipv4.filter((c) => !isCidr(c, 4)), ...ipv6.filter((c) => !isCidr(c, 6))];
    if (bad.length) throw new Error(`Danh sách có mục không hợp lệ hoặc quá rộng: ${bad.slice(0, 3).map((b) => JSON.stringify(b.slice(0, 40))).join(", ")}`);
    return { ipv4, ipv6 };
  } catch (e) {
    // Cảnh báo nhưng không chặn — dùng bản dự phòng đóng gói sẵn để lệnh vẫn
    // chạy được (an toàn hơn là để UFW/nginx không có rule Cloudflare nào).
    console.error(`[CẢNH BÁO] Không tải được dải IP Cloudflare mới nhất (${(e as Error).message}) — dùng bản dự phòng đóng gói sẵn trong napp.`);
    return { ipv4: FALLBACK_IPV4, ipv6: FALLBACK_IPV6 };
  }
}

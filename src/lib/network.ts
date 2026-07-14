import { existsSync } from "node:fs";

// Một số container/VPS tối giản không có ngăn xếp IPv6 — nếu nginx cấu hình
// `listen [::]:80` trên máy như vậy, `nginx -t` sẽ báo lỗi
// "socket() [::]:80 failed (97: Address family not supported by protocol)"
// và toàn bộ site sập theo. Phát hiện trước để sinh cấu hình phù hợp.
export function ipv6Available(): boolean {
  return existsSync("/proc/net/if_inet6");
}

import { createPublicKey, verify } from "node:crypto";

// --------------------------------------------------------------------------
// Chữ ký bản phát hành (OWASP A08). 'napp update' và install.sh chỉ cài một
// napp.cjs có chữ ký Ed25519 hợp lệ của MỘT trong các khoá dưới đây.
//
// Trước đây chỉ có HTTPS + 'node --check' + một chuỗi đánh dấu ai cũng chép
// được: ai chiếm được gist (hoặc tài khoản GitHub) là đẩy mã tuỳ ý chạy bằng
// ROOT lên MỌI server napp. Nay kẻ đó còn cần khoá bí mật — thứ không nằm trên
// GitHub, không nằm trong repo.
//
// Là một DANH SÁCH để xoay khoá được: bản napp mới mang thêm khoá mới (vẫn giữ
// khoá cũ) -> ký bằng khoá cũ lần cuối -> server nhận bản đó, từ đó tin cả khoá
// mới -> bỏ khoá cũ ở bản sau. Cùng danh sách phải có trong install.sh.
// --------------------------------------------------------------------------

export const TRUSTED_KEYS: readonly string[] = [
  // Khoá phát hành chính (tạo 2026-09-30 bằng scripts/keygen.mjs). SPKI, base64.
  "MCowBQYDK2VwAyEAGLWyHX06nz1YZpXpLHAyhheAPl0JlSlBWjsKIK/ftos=",
];

/** Chữ ký (base64) có hợp lệ với ĐÚNG các byte này, bởi một khoá tin cậy không. */
export function verifyRelease(data: Buffer, signatureB64: string): boolean {
  const sig = Buffer.from(signatureB64.trim(), "base64");
  if (sig.length !== 64) return false; // chữ ký Ed25519 luôn đúng 64 byte
  return TRUSTED_KEYS.some((k) => {
    try {
      return verify(null, data, createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), sig);
    } catch {
      return false;
    }
  });
}

/** So hai phiên bản dạng x.y.z: âm = a cũ hơn b. Không đọc được -> NaN. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return NaN;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

// Tạo cặp khoá Ed25519 để KÝ bản phát hành napp.
//
//   node scripts/keygen.mjs
//
// - Khoá BÍ MẬT ghi ra NGOÀI repo: $NAPP_SIGNING_KEY, mặc định
//   ~/.config/napp/signing-ed25519.pem. KHÔNG BAO GIỜ commit, KHÔNG gửi ai.
//   Sao lưu nó (password manager / USB offline): mất khoá là không ký được bản
//   mới mà các server đang chạy chấp nhận.
// - Khoá CÔNG KHAI in ra màn hình: dán vào TRUSTED_KEYS trong
//   src/lib/signature.ts và NAPP_TRUSTED_KEYS trong install.sh.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const keyPath = process.env.NAPP_SIGNING_KEY ?? join(homedir(), ".config", "napp", "signing-ed25519.pem");
if (existsSync(keyPath)) {
  console.error(`Đã có khoá tại ${keyPath} — không ghi đè (xoá tay nếu thật sự muốn tạo khoá mới).`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
try {
  chmodSync(keyPath, 0o600);
} catch {
  /* Windows: quyền theo ACL của thư mục người dùng */
}
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
console.log(`Khoá BÍ MẬT: ${keyPath}  (SAO LƯU NGAY — không commit, không chia sẻ)`);
console.log(`Khoá CÔNG KHAI (SPKI, base64):\n${pub}`);

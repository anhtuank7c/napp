// Ký dist/napp.cjs -> dist/napp.cjs.sig (Ed25519, base64, một dòng).
//
//   node scripts/sign.mjs            (chạy tự động trong 'npm run gist:napp')
//
// Ký trên ĐÚNG từng byte của file sẽ phát hành; server kiểm tra lại trên đúng
// từng byte tải về trước khi cài (src/commands/update.ts, install.sh).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const keyPath = process.env.NAPP_SIGNING_KEY ?? join(homedir(), ".config", "napp", "signing-ed25519.pem");
if (!existsSync(keyPath)) {
  console.error(`Không thấy khoá ký tại ${keyPath}. Tạo bằng: node scripts/keygen.mjs (hoặc đặt NAPP_SIGNING_KEY).`);
  process.exit(1);
}
const file = "dist/napp.cjs";
const data = readFileSync(file);
const key = createPrivateKey(readFileSync(keyPath));
const sig = sign(null, data, key);

// Tự kiểm tra: khoá này có nằm trong danh sách khoá tin cậy mà napp mang theo
// không. Không có thì server sẽ TỪ CHỐI bản này — dừng ngay ở đây, trước khi đăng.
const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
const trusted = readFileSync("src/lib/signature.ts", "utf8");
if (!trusted.includes(pub)) {
  console.error(`Khoá công khai của khoá ký này KHÔNG có trong TRUSTED_KEYS (src/lib/signature.ts):\n${pub}`);
  process.exit(1);
}
if (!verify(null, data, createPublicKey(key), sig)) {
  console.error("Tự kiểm tra chữ ký thất bại.");
  process.exit(1);
}
writeFileSync(`${file}.sig`, sig.toString("base64") + "\n");
console.log(`Đã ký ${file} -> ${file}.sig`);

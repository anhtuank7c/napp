import { writeFileSync, chmodSync, unlinkSync, readFileSync, mkdtempSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCapture, runCmd, requireRoot } from "../lib/exec";
import { info, ok, warn, die } from "../lib/log";
import { NAPP_VERSION, NAPP_UPDATE_URL_DEFAULT, CHANGELOG } from "../version";
import { verifyRelease, compareVersions } from "../lib/signature";
import { MOTD_PATH, writeMotdBanner } from "./installSelf";

const INSTALL_PATH = "/usr/local/bin/napp";

export function cmdVersion(): void {
  console.log(`napp version ${NAPP_VERSION}`);
}

export function cmdChangelog(): void {
  console.log(CHANGELOG);
}

// Tự cập nhật napp: tải về file tạm -> KIỂM TRA (cú pháp hợp lệ + đúng là
// napp.cjs) -> mới cài. KHÔNG dùng kiểu 'curl | bash' để tránh cài đè file
// hỏng/dở dang. Cùng triết lý an toàn với cmd_update() trong lara.sh.
async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
    die(`Tải thất bại (${url}) — kiểm tra URL hoặc kết nối mạng: ${(e as Error).message}`);
  });
  if (!res || !res.ok) die(`Tải thất bại (${url}) — HTTP ${res?.status ?? "?"}`);
  // BYTE THÔ, không qua chuỗi: chữ ký được kiểm tra trên đúng từng byte sẽ cài.
  return Buffer.from(await res.arrayBuffer());
}

export async function cmdUpdate(opts: { allowDowngrade?: boolean } = {}): Promise<void> {
  requireRoot();
  const url = process.env.NAPP_UPDATE_URL ?? NAPP_UPDATE_URL_DEFAULT;

  if (!url || url.includes("REPLACE_WITH_GIST_ID")) {
    die(
      "Chưa cấu hình nguồn cập nhật.\n" +
        "  Hãy tạo gist công khai chứa napp.cjs, rồi đặt URL raw 'mới nhất' của nó vào\n" +
        "  NAPP_UPDATE_URL_DEFAULT trong src/version.ts rồi build lại, hoặc ghi đè lúc chạy:\n" +
        '    sudo NAPP_UPDATE_URL="https://gist.githubusercontent.com/<user>/<id>/raw/napp.cjs" napp update'
    );
  }
  if (!url.startsWith("https://")) die(`URL cập nhật phải dùng HTTPS: ${url}`);

  info(`Đang tải bản mới nhất từ: ${url}`);
  const data = await download(url);
  const sigUrl = `${url.split("?")[0]}.sig`;
  const signature = (await download(sigUrl)).toString("utf8");

  // KIỂM TRA CHỮ KÝ TRƯỚC MỌI THỨ KHÁC — kể cả trước khi ghi ra đĩa hay chạy
  // 'node --check'. Không có cờ nào để bỏ qua bước này: một bản không ký được
  // là một bản napp KHÔNG chạy bằng root trên máy này.
  if (!verifyRelease(data, signature)) {
    die(
      "Chữ ký của bản tải về KHÔNG hợp lệ — KHÔNG cài.\n" +
        "  File có thể đã bị sửa (gist/tài khoản bị chiếm, bị chặn giữa đường) hoặc tải dở.\n" +
        `  Đã kiểm tra: ${url}\n  với chữ ký:   ${sigUrl}`
    );
  }
  info("Chữ ký hợp lệ (Ed25519, khoá phát hành của napp).");
  const content = data.toString("utf8");

  // Còn giữ để bắt lỗi đóng gói; KHÔNG phải kiểm tra bảo mật (chữ ký ở trên mới là).
  if (!content.includes("__NAPP_MARKER__")) die("File tải về không giống napp.cjs (thiếu marker) — KHÔNG cài.");
  const versionMatch = content.match(/__NAPP_MARKER__ version=(\S+)/);
  const newVersion = versionMatch?.[1] ?? "?";
  info(`Bản đang chạy: ${NAPP_VERSION}   ->   bản tải về: ${newVersion}`);

  // Chống hạ cấp: kẻ tấn công không tự ký được, nhưng có thể phát lại một bản
  // CŨ đã ký thật mà có lỗ hổng. Chỉ nhận bản cũ hơn khi người dùng chủ động yêu cầu.
  const cmp = compareVersions(newVersion, NAPP_VERSION);
  if (Number.isNaN(cmp)) die(`Không đọc được phiên bản của file tải về ('${newVersion}') — KHÔNG cài.`);
  if (cmp < 0 && !opts.allowDowngrade) {
    die(`Bản tải về (${newVersion}) CŨ HƠN bản đang chạy (${NAPP_VERSION}) — KHÔNG cài. Cố ý hạ cấp: sudo napp update --allow-downgrade`);
  }
  if (cmp === 0) warn(`Đã là bản mới nhất (${NAPP_VERSION}); vẫn cài lại cho chắc.`);

  const tmpDir = mkdtempSync(join(tmpdir(), "napp-update-"));
  const tmpPath = join(tmpDir, "napp.cjs");
  writeFileSync(tmpPath, data, { mode: 0o700 });

  // Kiểm tra cú pháp hợp lệ trước khi cài (bắt bản đóng gói hỏng).
  const syntaxCheck = execCapture("node", ["--check", tmpPath]);
  if (syntaxCheck.code !== 0) {
    unlinkSync(tmpPath);
    die(`File tải về lỗi cú pháp — KHÔNG cài:\n${syntaxCheck.stderr}`);
  }

  chmodSync(tmpPath, 0o755);
  runCmd("install", ["-m", "0755", tmpPath, INSTALL_PATH]);
  unlinkSync(tmpPath);
  ok(`Đã cập nhật napp: ${NAPP_VERSION} -> ${newVersion}  (${INSTALL_PATH})`);

  // Làm mới banner giới thiệu SSH theo bản mới (chỉ khi banner đang tồn tại —
  // không tự tạo lại nếu người dùng đã cố tình gỡ bằng 'napp uninstall').
  if (existsSync(MOTD_PATH)) {
    writeMotdBanner();
    info("Đã làm mới banner giới thiệu SSH.");
  }
}

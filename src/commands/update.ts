import { writeFileSync, chmodSync, unlinkSync, readFileSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCapture, runCmd, requireRoot } from "../lib/exec";
import { info, ok, warn, die } from "../lib/log";
import { NAPP_VERSION, NAPP_UPDATE_URL_DEFAULT, CHANGELOG } from "../version";

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
export async function cmdUpdate(): Promise<void> {
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
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
    die(`Tải thất bại — kiểm tra URL hoặc kết nối mạng: ${(e as Error).message}`);
  });
  if (!res || !res.ok) die(`Tải thất bại — HTTP ${res?.status ?? "?"}`);
  const content = await res.text();

  const tmpDir = mkdtempSync(join(tmpdir(), "napp-update-"));
  const tmpPath = join(tmpDir, "napp.cjs");
  writeFileSync(tmpPath, content, "utf8");

  // Kiểm tra cú pháp hợp lệ trước khi cài.
  const syntaxCheck = execCapture("node", ["--check", tmpPath]);
  if (syntaxCheck.code !== 0) {
    unlinkSync(tmpPath);
    die(`File tải về lỗi cú pháp — KHÔNG cài (có thể tải dở/hỏng):\n${syntaxCheck.stderr}`);
  }

  // Xác thực đúng là napp.cjs (có marker do esbuild.config.mjs chèn vào).
  if (!content.includes("__NAPP_MARKER__")) {
    unlinkSync(tmpPath);
    die("File tải về không giống napp.cjs (thiếu marker) — KHÔNG cài.");
  }

  const versionMatch = content.match(/__NAPP_MARKER__ version=(\S+)/);
  const newVersion = versionMatch?.[1] ?? "?";
  info(`Bản đang chạy: ${NAPP_VERSION}   ->   bản tải về: ${newVersion}`);
  if (newVersion === NAPP_VERSION) {
    warn(`Đã là bản mới nhất (${NAPP_VERSION}); vẫn cài lại cho chắc.`);
  }

  chmodSync(tmpPath, 0o755);
  runCmd("install", ["-m", "0755", tmpPath, INSTALL_PATH]);
  unlinkSync(tmpPath);
  ok(`Đã cập nhật napp: ${NAPP_VERSION} -> ${newVersion}  (${INSTALL_PATH})`);
}

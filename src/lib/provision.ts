import { execCapture, runCmd, commandExists } from "./exec";
import { info, ok, die } from "./log";
import type { Runtime, PackageManager } from "./state";

// Trình quản lý gói mặc định khi người dùng không chỉ định: runtime bun dùng
// bun, còn lại dùng npm (luôn có sẵn cùng Node).
export function defaultPackageManager(runtime: Runtime): PackageManager {
  return runtime === "bun" ? "bun" : "npm";
}

// Lệnh cài dependencies theo từng package manager. TẤT CẢ đều "lockfile-aware":
// nếu có lockfile thì cài đúng theo lock (nhanh, tất định) và fallback cài
// thường khi lock lệch; nếu KHÔNG có lockfile (app mẫu / repo chưa commit lock)
// thì cài thẳng để tránh lỗi kiểu `npm ci` EUSAGE.
export function defaultInstallCmd(pm: PackageManager): string {
  switch (pm) {
    case "bun":
      // Có bun lockfile -> cài frozen (tất định), fallback ghi lại nếu lock lệch.
      // KHÔNG có bun lockfile (repo mang lockfile pnpm/npm/yarn, hoặc chưa commit
      // lock): bun MIGRATE sang bun.lock = "thay đổi lockfile". Nếu frozen bị bật
      // (bunfig.toml frozenLockfile=true, biến CI, ...) sẽ lỗi "lockfile is frozen"
      // -> ép --no-frozen-lockfile để bun được phép ghi lock migrate.
      return "if [ -f bun.lockb ] || [ -f bun.lock ]; then bun install --production --frozen-lockfile || bun install --production --no-frozen-lockfile; else bun install --production --no-frozen-lockfile; fi";
    case "pnpm":
      return "if [ -f pnpm-lock.yaml ]; then pnpm install --prod --frozen-lockfile || pnpm install --prod; else pnpm install --prod; fi";
    case "yarn":
      // yarn classic hiểu --frozen-lockfile; yarn berry hiểu --immutable — thử lần lượt cho tương thích cả hai.
      return "if [ -f yarn.lock ]; then yarn install --production --frozen-lockfile || yarn install --immutable || yarn install; else yarn install --production || yarn install; fi";
    case "npm":
    default:
      return "if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --omit=dev || npm install --omit=dev; else npm install --omit=dev; fi";
  }
}

// Lệnh khởi động mặc định. Runtime bun luôn chạy bằng `bun run start`. Runtime
// node chạy script "start" qua chính package manager đã chọn (npm/pnpm/yarn);
// nếu lỡ ghép node + bun thì dùng npm cho an toàn (npm luôn có cùng Node).
export function defaultStartCmd(runtime: Runtime, pm: PackageManager): string {
  if (runtime === "bun") return "bun run start";
  return pm === "bun" ? "npm start" : `${pm} start`;
}

// Kiểm tra một lệnh có sẵn Ở MỨC HỆ THỐNG không (/usr, /opt, /bin) — tức MỌI user
// (kể cả user hệ thống chạy qua systemd / login shell) đều gọi được. Khác
// commandExists (chỉ dò PATH của root): pnpm/bun cài trong home của root sẽ KHÔNG
// tính là hệ thống, và đó chính là bẫy khiến bước cài deps báo 'command not found'.
export function commandExistsSystemWide(cmd: string): boolean {
  const res = execCapture("bash", ["-lc", `p="$(command -v ${cmd} 2>/dev/null)" && readlink -f "$p"`]);
  if (res.code !== 0) return false;
  return /^\/(usr|opt|bin|sbin)\//.test(res.stdout.trim());
}

// Đảm bảo trình quản lý gói dùng được ở mức hệ thống trước khi tạo app/service.
// npm đi kèm Node. pnpm/yarn thiếu thì cài global qua npm (-> /usr/bin, mọi user
// thấy). bun phải được cài sẵn system-wide (do install.sh) — thiếu thì báo lỗi rõ.
export function ensurePackageManager(pm: PackageManager): void {
  if (pm === "npm") return;
  if (commandExistsSystemWide(pm)) return;
  if (pm === "bun") {
    die(
      "bun chưa được cài ở mức hệ thống. Cài lại bằng install.sh (mặc định có cài bun), hoặc:\n" +
        "  sudo bash -c 'export BUN_INSTALL=/usr/local; curl -fsSL https://bun.sh/install | bash'\n" +
        "rồi thử lại — hoặc chọn package manager khác."
    );
  }
  info(`'${pm}' chưa có ở mức hệ thống — đang cài global bằng 'npm install -g ${pm}'...`);
  runCmd("npm", ["install", "-g", pm]);
  if (!commandExistsSystemWide(pm)) {
    die(`Đã chạy 'npm install -g ${pm}' nhưng '${pm}' vẫn chưa dùng được ở mức hệ thống. Hãy cài '${pm}' thủ công rồi thử lại.`);
  }
  ok(`Đã cài '${pm}' ở mức hệ thống.`);
}

// Kiểm tra runtime engine (node/bun) đã cài chưa — dùng chung cho app và service.
export function ensureRuntime(runtime: Runtime): void {
  if (runtime === "node" && !commandExists("node")) {
    die("Node.js chưa được cài. Chạy 'napp check --fix' trước.");
  }
  if (runtime === "bun" && !commandExistsSystemWide("bun")) {
    die(
      "bun chưa được cài ở mức hệ thống (runtime=bun cần bun để chạy). Cài lại bằng install.sh\n" +
        "  (mặc định có cài bun), hoặc: sudo bash -c 'export BUN_INSTALL=/usr/local; curl -fsSL https://bun.sh/install | bash'\n" +
        "rồi thử lại — hoặc chọn runtime node."
    );
  }
}

// Đóng gói toàn bộ CLI thành MỘT file CommonJS duy nhất (dist/napp.cjs),
// giống tinh thần "một file duy nhất" của lara.sh — dễ tải về qua gist raw
// và cài vào /usr/local/bin/napp mà không cần `npm install` trên server đích.
import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url)));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/napp.cjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __NAPP_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
});

chmodSync("dist/napp.cjs", 0o755);

// Chèn version marker dễ grep để cmd_update xác thực file tải về thực sự là
// napp.cjs hợp lệ (tương tự lara kiểm tra '^LARA_VERSION='). LƯU Ý: chuỗi
// "__NAPP_MARKER__" đã xuất hiện SẴN trong bundle vì src/commands/update.ts
// tham chiếu nó theo nghĩa đen (content.includes("__NAPP_MARKER__")) — vì
// vậy KHÔNG thể dùng includes() để kiểm tra "đã chèn hay chưa". Ta chèn
// dòng comment kèm version= ngay sau banner một cách vô điều kiện.
const content = readFileSync("dist/napp.cjs", "utf8");
const markerLine = `// __NAPP_MARKER__ version=${pkg.version}`;
const patched = content.replace("#!/usr/bin/env node\n", `#!/usr/bin/env node\n${markerLine}\n`);
writeFileSync("dist/napp.cjs", patched);
chmodSync("dist/napp.cjs", 0o755);

console.log(`Built dist/napp.cjs (v${pkg.version})`);

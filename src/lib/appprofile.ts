import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Runtime, PackageManager } from "./state";
import { defaultInstallCmd, defaultStartCmd, devInstallCmd, pruneDevDepsCmd } from "./provision";

/**
 * Nhận diện FRAMEWORK CHẠY PHÍA SERVER của app (NestJS, Express, Fastify, Hono…)
 * từ package.json, để chọn lệnh build/start mặc định ĐÚNG thay vì 'npm start'
 * cho mọi thứ.
 *
 * Khác lib/framework.ts (đọc THƯ MỤC BUILD để cấu hình asset tĩnh cho nginx):
 * ở đây chạy NGAY SAU khi clone, TRƯỚC khi cài/build, nên chỉ có package.json
 * để đọc. Nhận diện sai chỉ dẫn tới một lệnh mặc định không hợp — người dùng
 * luôn ghi đè được bằng --build-cmd / --start-cmd, và cờ truyền tay luôn thắng.
 *
 * Ba lỗi hay gặp nhất mà module này chặn:
 *  1. Build TypeScript cần devDependencies (typescript, @nestjs/cli, tsup…),
 *     nhưng napp mặc định cài '--omit=dev' -> 'nest: not found' / 'tsc: not
 *     found'. Có build thì cài đủ, build xong mới prune devDependencies.
 *  2. 'npm start' của NestJS là 'nest start' — biên dịch lại mỗi lần chạy và
 *     cần @nestjs/cli (devDependency). Production phải là 'start:prod'
 *     ('node dist/main').
 *  3. Script start là lệnh DEV (nodemon, tsx watch, next dev…): chạy được nhưng
 *     chậm, tốn RAM, và chết ngay khi devDependencies bị prune.
 */
export interface AppProfile {
  /** Tên hiển thị, vd "NestJS". undefined = không nhận ra (dùng mặc định chung). */
  framework?: string;
  /** package.json ở thư mục build (gốc repo) có script "build". */
  hasBuildScript: boolean;
  /** Lệnh start đề xuất; undefined = giữ mặc định chung ('<pm> start'). */
  startCmd?: string;
  /** Vì sao chọn startCmd — in cho người dùng. */
  startReason?: string;
  /** Vấn đề cần người dùng xử lý (in bằng warn). */
  warnings: string[];
  /** Gợi ý cấu hình trong mã nguồn khi chạy sau nginx (in ở cuối). */
  hints: string[];
  /** Biến .env framework BẮT BUỘC phải có mới khởi động được. */
  env: Record<string, string>;
}

interface Pkg {
  main?: string;
  module?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(dir: string): Pkg | undefined {
  const p = `${dir.replace(/\/+$/, "")}/package.json`;
  if (!existsSync(p)) return undefined;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Pkg) : undefined;
  } catch {
    return undefined;
  }
}

// --- Bảng framework ------------------------------------------------------------

interface FrameworkRule {
  name: string;
  /** Có MỘT trong các gói này trong dependencies/devDependencies là khớp. */
  packages: string[];
  /** Gợi ý cho WEB app (đứng sau nginx). Worker không có cổng nên không cần. */
  webHints?: (runtime: Runtime) => string[];
  /** Lệnh start khi KHÔNG có script start phù hợp. */
  fallbackStart?: (run: (file: string) => string) => string;
}

const TRUST_EXPRESS = "Sau nginx: app.set('trust proxy', 'loopback') — thiếu thì req.ip luôn là 127.0.0.1, req.secure = false và cookie 'secure' (express-session…) không được gửi.";

/**
 * XÉT THEO THỨ TỰ, luật đầu tiên khớp thắng. NestJS và AdonisJS đứng đầu vì
 * chúng kéo theo express/fastify làm phụ thuộc — xét express trước là nhận nhầm.
 * Express đứng CUỐI: rất nhiều thư viện (và app dùng framework khác) có nó.
 */
const FRAMEWORKS: FrameworkRule[] = [
  {
    name: "NestJS",
    packages: ["@nestjs/core"],
    webHints: () => [
      "main.ts phải nghe cổng từ .env: await app.listen(process.env.PORT ?? 3000) (scaffold mới đã có sẵn).",
      "Sau nginx: NestExpressApplication -> app.set('trust proxy', 'loopback'); FastifyAdapter -> new FastifyAdapter({ trustProxy: '127.0.0.1' }).",
    ],
    fallbackStart: (run) => run("dist/main.js"),
  },
  {
    name: "AdonisJS",
    packages: ["@adonisjs/core"],
    webHints: () => [
      "napp đã đặt HOST=127.0.0.1, LOG_LEVEL và APP_KEY (ngẫu nhiên) trong .env — env.ts của Adonis bắt buộc có chúng.",
      "Sau nginx: config/app.ts -> http.trustProxy: proxyAddr.compile('loopback').",
    ],
    // 'node ace build' xuất ra build/; module resolution đi ngược lên node_modules
    // ở gốc nên không cần cài lại deps trong build/.
    fallbackStart: (run) => run("build/bin/server.js"),
  },
  {
    name: "Fastify",
    packages: ["fastify"],
    webHints: () => [
      "Fastify KHÔNG tự đọc PORT: fastify.listen({ port: Number(process.env.PORT), host: '127.0.0.1' }).",
      "Sau nginx: Fastify({ trustProxy: '127.0.0.1' }) để request.ip / request.protocol đúng.",
    ],
  },
  {
    name: "Hono",
    packages: ["hono"],
    webHints: (runtime) =>
      runtime === "bun"
        ? ["Bun tự nghe cổng PORT khi file chính 'export default app' — không cần làm gì thêm."]
        : ["@hono/node-server mặc định cổng 3000, KHÔNG tự đọc PORT: serve({ fetch: app.fetch, port: Number(process.env.PORT) })."],
  },
  {
    name: "Elysia",
    packages: ["elysia"],
    webHints: () => ["Nghe cổng từ .env: new Elysia()...listen(Number(process.env.PORT))."],
  },
  {
    name: "Koa",
    packages: ["koa"],
    webHints: () => ["Nghe cổng: app.listen(process.env.PORT).", "Sau nginx: app.proxy = true để ctx.ip / ctx.protocol đọc X-Forwarded-*."],
  },
  {
    name: "hapi",
    packages: ["@hapi/hapi"],
    webHints: () => ["Hapi.server({ port: process.env.PORT, host: '127.0.0.1' }) — hapi mặc định cổng ngẫu nhiên nếu không truyền."],
  },
  // Full-stack: chỉ cần lệnh start dự phòng khi repo không có script "start".
  { name: "Next.js", packages: ["next"] },
  { name: "Nuxt", packages: ["nuxt"], fallbackStart: (run) => run(".output/server/index.mjs") },
  { name: "SvelteKit", packages: ["@sveltejs/kit"], fallbackStart: (run) => run("build") },
  { name: "Remix / React Router", packages: ["@remix-run/node", "@react-router/node"] },
  { name: "Astro", packages: ["astro"], fallbackStart: (run) => run("dist/server/entry.mjs") },
  {
    name: "Express",
    packages: ["express"],
    webHints: () => ["Nghe cổng từ .env: app.listen(process.env.PORT).", TRUST_EXPRESS],
  },
];

// Script start là lệnh DEV: watch/hot-reload, dev server của framework.
const DEV_START = /\b(nodemon|ts-node-dev|tsx\s+watch|next\s+dev|nuxt\s+dev|nuxi\s+dev|astro\s+dev|remix\s+dev|react-router\s+dev|vite(?!\s+(build|preview))(\s|$))|--watch\b|--hot\b|\bnest\s+start\b(?![^&|;]*--)/;
// Công cụ gần như luôn nằm trong devDependencies: start dùng chúng thì prune là chết.
const DEV_RUNNERS = ["tsx", "ts-node", "ts-node-dev", "nodemon", "babel-node", "nest", "vite"];

function usesDevRunner(script: string, pkg: Pkg): boolean {
  const dev = pkg.devDependencies ?? {};
  const pkgOf: Record<string, string> = { nest: "@nestjs/cli", "babel-node": "@babel/node" };
  return DEV_RUNNERS.some((bin) => new RegExp(`(^|[\\s;&|])${bin.replace(/-/g, "\\-")}(\\s|$)`).test(script) && (pkgOf[bin] ?? bin) in dev);
}

/** Lệnh chạy một script npm qua đúng package manager (bun runtime -> bun). */
export function runScriptCmd(runtime: Runtime, pm: PackageManager, script: string): string {
  if (runtime === "bun") return `bun run ${script}`;
  const r = pm === "bun" ? "npm" : pm;
  return script === "start" ? `${r} start` : `${r} run ${script}`;
}

function runFile(runtime: Runtime): (file: string) => string {
  return (file) => `${runtime === "bun" ? "bun" : "node"} ${file}`;
}

/**
 * `buildDir`: nơi lệnh cài/build chạy (gốc repo). `workDir`: nơi app chạy
 * (gốc repo, hoặc --app-dir của monorepo) — script start và phụ thuộc của app
 * đọc ở đây, dự phòng gốc repo.
 */
export function detectAppProfile(
  buildDir: string,
  workDir: string,
  runtime: Runtime,
  pm: PackageManager,
  kind: "web" | "service"
): AppProfile {
  const rootPkg = readPkg(buildDir);
  const pkg = readPkg(workDir) ?? rootPkg;
  const profile: AppProfile = {
    hasBuildScript: Boolean(rootPkg?.scripts?.build),
    warnings: [],
    hints: [],
    env: {},
  };
  if (!pkg) return profile;

  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const rule = FRAMEWORKS.find((f) => f.packages.some((p) => p in deps));
  profile.framework = rule?.name;
  if (rule && kind === "web") profile.hints.push(...(rule.webHints?.(runtime) ?? []));

  const scripts = pkg.scripts ?? {};
  const run = runFile(runtime);
  const prod = ["start:prod", "start:production", "serve:prod"].find((s) => scripts[s]);

  if (rule?.name === "NestJS") {
    // 'start' của Nest là 'nest start': biên dịch lúc chạy, cần @nestjs/cli.
    if (prod) {
      profile.startCmd = runScriptCmd(runtime, pm, prod);
      profile.startReason = `NestJS: dùng script '${prod}' (script 'start' là 'nest start' — chế độ dev)`;
    } else {
      profile.startCmd = run("dist/main.js");
      profile.startReason = "NestJS: chạy bản build 'dist/main.js' (không có script start:prod)";
    }
  } else if (rule?.name === "AdonisJS") {
    profile.startCmd = run("build/bin/server.js");
    profile.startReason = "AdonisJS: chạy bản build 'build/bin/server.js' (script 'start' của Adonis chỉ đúng khi đứng trong build/)";
    profile.env = { HOST: "127.0.0.1", LOG_LEVEL: "info" };
  } else if (scripts.start) {
    if (DEV_START.test(scripts.start)) {
      if (prod) {
        profile.startCmd = runScriptCmd(runtime, pm, prod);
        profile.startReason = `script 'start' là lệnh dev ('${scripts.start}') — dùng '${prod}'`;
      } else {
        profile.warnings.push(
          `Script 'start' là lệnh DEV: '${scripts.start}'. Chạy production bằng nó thì chậm, tốn RAM và có thể chết khi devDependencies bị gỡ.\n` +
            `  Thêm script 'start:prod' vào package.json, hoặc truyền --start-cmd (vd: --start-cmd 'node dist/index.js').`
        );
      }
    }
  } else if (rule?.fallbackStart) {
    profile.startCmd = rule.fallbackStart(run);
    profile.startReason = `${rule.name}: package.json không có script 'start'`;
  } else {
    // Bun chạy thẳng TypeScript: scaffold Hono/Elysia cho Bun chỉ có script
    // 'dev' (bun --hot src/index.ts) và trường 'module' — chạy đúng file đó.
    const dir = existsSync(`${workDir}/package.json`) ? workDir : buildDir;
    const entry =
      runtime === "bun"
        ? [pkg.module, pkg.main, "src/index.ts", "index.ts"].find((f) => f && existsSync(`${dir.replace(/\/+$/, "")}/${f}`))
        : pkg.main;
    if (entry) {
      profile.startCmd = run(entry);
      profile.startReason = `package.json không có script 'start' — chạy file chính '${entry}'`;
    } else {
      profile.warnings.push(
        `package.json không có script 'start' và không có file chính — truyền --start-cmd (vd: --start-cmd '${runtime === "bun" ? "bun src/index.ts" : "node dist/index.js"}').`
      );
    }
  }

  return profile;
}

/**
 * Lệnh start có cần devDependencies lúc CHẠY không (tsx, ts-node, nodemon…). Lệnh
 * dạng '<pm> start' / '<pm> run x' được tra ra nội dung script trong package.json.
 */
export function startNeedsDevDeps(startCmd: string, workDir: string, buildDir: string): boolean {
  const pkg = readPkg(workDir) ?? readPkg(buildDir);
  if (!pkg) return false;
  const m = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(startCmd.trim());
  const script = m ? (pkg.scripts?.[m[1]!] ?? startCmd) : startCmd;
  return usesDevRunner(script, pkg);
}

export interface UnitCommands {
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  profile: AppProfile;
  /** Dòng giải thích các lựa chọn tự động — in bằng info. */
  notes: string[];
}

/**
 * Chốt bộ ba install/build/start cho app/service MỚI. Cờ người dùng truyền tay
 * LUÔN thắng; phần còn lại suy từ package.json:
 *  - build: có script "build" thì chạy nó ('--build-cmd ""' để tắt);
 *  - install: có build (hoặc start cần tsx/ts-node…) thì cài ĐỦ devDependencies;
 *  - build xong gỡ devDependencies (trừ khi start cần chúng / --keep-dev-deps).
 * Prune nối vào buildCmd nên 'app deploy' tự làm lại đúng trình tự mà không cần
 * thêm trường nào vào state.json — bản napp cũ đọc state vẫn chạy được.
 */
export function resolveUnitCommands(
  opts: { installCmd?: string; buildCmd?: string; startCmd?: string; keepDevDeps?: boolean },
  buildDir: string,
  workDir: string,
  runtime: Runtime,
  pm: PackageManager,
  kind: "web" | "service"
): UnitCommands {
  const profile = detectAppProfile(buildDir, workDir, runtime, pm, kind);
  const notes: string[] = [];
  if (profile.framework) notes.push(`Nhận diện framework: ${profile.framework}`);

  let buildCmd = opts.buildCmd ?? (profile.hasBuildScript ? runScriptCmd(runtime, pm, "build") : "");
  if (opts.buildCmd === undefined && buildCmd) notes.push(`Có script 'build' -> build bằng '${buildCmd}' (tắt: --build-cmd '')`);

  const startCmd = opts.startCmd ?? profile.startCmd ?? defaultStartCmd(runtime, pm);
  if (opts.startCmd === undefined && profile.startCmd) notes.push(`Lệnh start: '${startCmd}' — ${profile.startReason}`);

  if (opts.installCmd !== undefined) return { installCmd: opts.installCmd, buildCmd, startCmd, profile, notes };

  const runNeedsDev = startNeedsDevDeps(startCmd, workDir, buildDir);
  if (!buildCmd && !runNeedsDev) return { installCmd: defaultInstallCmd(pm), buildCmd, startCmd, profile, notes };

  const installCmd = devInstallCmd(pm);
  if (runNeedsDev) {
    notes.push("Lệnh start dùng công cụ trong devDependencies (tsx/ts-node/nodemon…) -> cài và GIỮ devDependencies. Nên build ra JS rồi chạy bằng node.");
  } else if (opts.keepDevDeps) {
    notes.push("Cài đủ devDependencies để build và giữ lại (--keep-dev-deps).");
  } else {
    const prune = pruneDevDepsCmd(pm);
    if (prune) {
      // Nhóm '{ …; }': 'build && prune || echo' sẽ NUỐT lỗi build (echo chạy khi build hỏng và trả 0).
      buildCmd = `${buildCmd} && { ${prune}; }`;
      notes.push("Cài đủ devDependencies để build, build xong gỡ chúng (giữ: --keep-dev-deps).");
    } else {
      notes.push(`Cài đủ devDependencies để build (${pm} chưa có cách gỡ an toàn tại chỗ — giữ nguyên).`);
    }
  }
  return { installCmd, buildCmd, startCmd, profile, notes };
}

/** Biến .env framework cần để khởi động (AdonisJS: APP_KEY sinh mới mỗi app). */
export function frameworkEnv(p: AppProfile): Record<string, string> {
  const env = { ...p.env };
  if (p.framework === "AdonisJS") env.APP_KEY = randomBytes(32).toString("hex");
  return env;
}

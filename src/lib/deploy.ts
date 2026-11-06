import { existsSync } from "node:fs";
import { runAs, runCmd, execCaptureAs, chmodNoFollow, state as execState } from "./exec";
import { info, ok, warn, die, step, colorText } from "./log";
import { gitEnvFor, repoIsSsh, type UnitKind } from "./repo";
import { ensurePackageManager, pruneDevDepsCmd } from "./provision";
import { unitWorkDir } from "../templates/systemd";
import type { PackageManager } from "./state";

// ---------------------------------------------------------------------------
// Đồng bộ mã nguồn từ git và deploy bản mới — dùng chung cho app web và
// background service. Khác bản cũ (luôn pull + install + build + restart):
//  - Không có commit mới -> KHÔNG làm gì (không restart vô cớ). --force để ép.
//  - Chỉ đổi tài liệu/CI (README, .github/…) -> cập nhật mã nguồn, không restart.
//  - Lockfile/package.json không đổi và không có build -> bỏ qua bước cài.
//  - --check: chỉ fetch và báo có gì mới, không đụng vào mã nguồn đang chạy.
// ---------------------------------------------------------------------------

export interface DeployTarget {
  kind: UnitKind;
  id: string;
  user: string;
  root: string; // webRoot (app) / workDir (service) — gốc repo
  appDir?: string;
  repoUrl: string;
  branch: string;
  deployKey?: string;
  installCmd: string;
  buildCmd: string;
  packageManager?: PackageManager;
}

export interface DeployOptions {
  check?: boolean; // chỉ xem có bản mới không
  force?: boolean; // chạy đủ install + build + restart dù không có gì mới
  restart?: boolean; // false = --no-restart: cập nhật + build, restart sau
}

export interface DeployPlan {
  current: string;
  target: string;
  commits: string[];
  files?: string[]; // undefined = không so được (lịch sử shallow, force-push…) -> coi như đổi hết
  upToDate: boolean;
  changed: boolean; // có thay đổi ảnh hưởng bản chạy (không tính tài liệu/CI)
  install: boolean;
  build: boolean;
  restart: boolean;
  reasons: string[];
}

// File không đi vào bản chạy: đổi chúng không cần build/restart. CHỈ ở gốc repo
// và chỉ những thứ chắc chắn — *.md nói chung thì KHÔNG (Astro/Nuxt Content
// build nội dung từ markdown).
const NON_RUNTIME = [
  /^\.github\//,
  /^\.gitlab\//,
  /^\.gitlab-ci\.yml$/,
  /^\.vscode\//,
  /^\.idea\//,
  /^(README|CHANGELOG|LICENSE|LICENCE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)(\.[a-z]+)?$/i,
];

const DEP_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc.yml",
  "bun.lockb",
  "bun.lock",
  ".npmrc",
]);

function git(t: DeployTarget, args: string[]): { code: number; out: string; err: string } {
  const r = execCaptureAs(t.user, "git", args, { cwd: t.root, env: gitEnvFor(t.deployKey), timeoutMs: 120_000 });
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

function cmdName(t: DeployTarget): string {
  return t.kind === "app" ? "app" : "service";
}

/** Commit hiện tại của mã nguồn (undefined nếu không đọc được / dry-run). */
export function headCommit(user: string, root: string): string | undefined {
  if (execState.dryRun) return undefined;
  const r = execCaptureAs(user, "git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Fetch branch từ remote. Trả về commit hiện tại + commit mới nhất trên remote. */
export function fetchRemote(t: DeployTarget): { current: string; target: string } {
  if (t.deployKey && !existsSync(t.deployKey)) {
    die(
      `Không thấy deploy key ${t.deployKey} (user chạy đã đổi, hoặc key bị xoá).\n` +
        `  Sinh key mới rồi thêm vào repo: napp ${cmdName(t)} deploy-key ${t.id} --regenerate`
    );
  }
  const current = git(t, ["rev-parse", "HEAD"]);
  if (current.code !== 0) die(`${t.root} không phải repo git hợp lệ: ${current.err}`);
  // FETCH_HEAD thay vì origin/<branch>: không phụ thuộc refspec của bản clone.
  const f = git(t, ["fetch", "--no-tags", "origin", t.branch]);
  if (f.code !== 0) {
    const auth = /permission denied|publickey|authentication|could not read|access denied|not found/i.test(f.err);
    const hint = auth
      ? repoIsSsh(t.repoUrl)
        ? `\n  Repo từ chối deploy key? Xem lại / sinh key mới: napp ${cmdName(t)} deploy-key ${t.id}`
        : "\n  Token hết hạn hoặc bị thu hồi? Cấp token mới có quyền đọc repo."
      : "";
    die(`git fetch thất bại: ${f.err.split("\n").slice(-3).join(" / ")}${hint}`);
  }
  const target = git(t, ["rev-parse", "FETCH_HEAD"]);
  if (target.code !== 0) die(`Không đọc được commit vừa fetch: ${target.err}`);
  return { current: current.out, target: target.out };
}

export function planDeploy(t: DeployTarget, refs: { current: string; target: string }, o: DeployOptions): DeployPlan {
  const { current, target } = refs;
  const upToDate = current === target;
  const reasons: string[] = [];
  let commits: string[] = [];
  let files: string[] | undefined = [];
  if (!upToDate) {
    const log = git(t, ["log", "--oneline", "--no-decorate", "-n", "15", `${current}..${target}`]);
    commits = log.code === 0 && log.out ? log.out.split("\n") : [];
    const diff = git(t, ["diff", "--name-only", current, target]);
    files = diff.code === 0 ? diff.out.split("\n").filter(Boolean) : undefined;
  }
  const wantRestart = o.restart !== false;
  if (o.force) {
    reasons.push("--force: chạy đủ cài đặt + build + restart");
    return { current, target, commits, files, upToDate, changed: true, install: true, build: Boolean(t.buildCmd), restart: wantRestart, reasons };
  }
  if (upToDate) return { current, target, commits, files, upToDate, changed: false, install: false, build: false, restart: false, reasons };

  const runtimeFiles = files?.filter((f) => !NON_RUNTIME.some((re) => re.test(f)));
  const changed = runtimeFiles === undefined || runtimeFiles.length > 0;
  if (files === undefined) reasons.push("không so được thay đổi (lịch sử bị cắt/force-push) -> deploy đầy đủ");
  else if (!changed) reasons.push("chỉ đổi tài liệu/CI -> cập nhật mã nguồn, không build/restart");

  const depsChanged = runtimeFiles === undefined || runtimeFiles.some((f) => DEP_FILES.has(f.split("/").pop()!));
  const workDir = unitWorkDir(t.root, t.appDir);
  const noModules = !existsSync(`${workDir}/node_modules`) && !existsSync(`${t.root}/node_modules`);
  const build = changed && Boolean(t.buildCmd);
  // Lệnh build mặc định GỠ devDependencies sau khi build xong -> build lần sau
  // phải cài lại, không thì thiếu typescript/vite… và gãy.
  const prune = t.packageManager ? pruneDevDepsCmd(t.packageManager) : undefined;
  const buildPrunes = Boolean(prune && t.buildCmd.includes(prune));
  const install = changed && (depsChanged || noModules || (build && buildPrunes));
  if (changed) {
    if (depsChanged && files !== undefined) reasons.push("dependencies thay đổi -> cài lại");
    else if (noModules) reasons.push("chưa có node_modules -> cài");
    else if (install) reasons.push("build cần devDependencies (đã gỡ sau lần build trước) -> cài lại");
    else reasons.push("dependencies không đổi -> bỏ qua bước cài");
  }
  return { current, target, commits, files, upToDate, changed, install, build, restart: changed && wantRestart, reasons };
}

const short = (sha: string) => sha.slice(0, 7);

export function printPlan(t: DeployTarget, p: DeployPlan): void {
  if (p.upToDate) {
    ok(`${t.id}: đã ở bản mới nhất của '${t.branch}' (${short(p.current)}).`);
  } else {
    info(`${t.id}: ${short(p.current)} -> ${short(p.target)} trên '${t.branch}'${p.files ? ` · ${p.files.length} file đổi` : ""}`);
    for (const c of p.commits) step(c);
    if (p.commits.length === 15) step(colorText("dim", "…"));
  }
  for (const r of p.reasons) step(colorText("dim", r));
  if (!p.upToDate || p.install || p.build || p.restart) {
    const yes = (b: boolean) => (b ? colorText("green", "có") : colorText("dim", "không"));
    step(`cài dependencies: ${yes(p.install)} · build: ${yes(p.build)} · restart: ${yes(p.restart)}`);
  }
}

/**
 * Áp kế hoạch: đưa mã nguồn về commit mới, cài, build, rồi gọi `restart`.
 * Hỏng ở install/build thì CHƯA restart: tiến trình đang chạy vẫn là bản cũ.
 */
export function applyDeploy(t: DeployTarget, p: DeployPlan, restart: () => void): void {
  if (!p.upToDate) {
    runAs(t.user, "git", ["reset", "--hard", p.target], { cwd: t.root, env: gitEnvFor(t.deployKey) });
  }
  try {
    if (p.install || p.build) {
      // Trình quản lý gói phải dùng được ở mức hệ thống (tự cài pnpm/yarn nếu thiếu).
      if (t.packageManager) ensurePackageManager(t.packageManager);
    }
    if (p.install) {
      info("Đang cài dependencies...");
      runAs(t.user, "bash", ["-lc", t.installCmd], { cwd: t.root });
    }
    if (p.build) {
      info("Đang build...");
      runAs(t.user, "bash", ["-lc", t.buildCmd], { cwd: t.root });
    }
  } catch (e) {
    if (!p.upToDate && !execState.dryRun) {
      warn(
        `Deploy dừng giữa chừng — CHƯA restart, tiến trình đang chạy vẫn là bản cũ ${short(p.current)}.\n` +
          `  Mã nguồn trên đĩa đã ở ${short(p.target)}. Sửa lỗi, push rồi chạy lại: napp ${cmdName(t)} deploy ${t.id}\n` +
          `  Hoặc đưa mã nguồn về bản cũ: sudo -u ${t.user} git -C ${t.root} reset --hard ${short(p.current)} && napp ${cmdName(t)} deploy ${t.id} --force`
      );
    }
    throw e;
  }
  runCmd("chown", ["-hR", `${t.user}:${t.user}`, t.root]);
  chmodNoFollow(`${unitWorkDir(t.root, t.appDir)}/.env`, 0o600);
  if (p.restart) restart();
}

/** Toàn bộ luồng deploy một đơn vị. Trả về kế hoạch đã chạy (sync dùng để tổng kết). */
export function deployUnit(t: DeployTarget, o: DeployOptions, restart: () => void): DeployPlan {
  info(`Đang lấy bản mới từ ${t.repoUrl} (${t.branch})...`);
  const plan = planDeploy(t, fetchRemote(t), o);
  printPlan(t, plan);
  if (o.check) return plan;
  if (plan.upToDate && !o.force) {
    info(`Không có gì để deploy. Muốn cài lại + build + restart: napp ${cmdName(t)} deploy ${t.id} --force`);
    return plan;
  }
  applyDeploy(t, plan, restart);
  if (o.restart === false && plan.changed) {
    info(`Đã cập nhật mã nguồn, CHƯA restart (--no-restart). Áp dụng bản mới: napp ${cmdName(t)} restart ${t.id}`);
  }
  return plan;
}

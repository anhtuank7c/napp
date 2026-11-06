import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { execCapture, execCaptureAs, runAs, state as execState } from "./exec";
import { info, ok, warn, die, colorText, section } from "./log";
import { ask } from "./prompt";
import { repoHost, repoIsSsh, gitEnvFor, ensureUserSshDir, deployKeyPathFor, sshCommandFor, type UnitKind } from "./repo";

// ---------------------------------------------------------------------------
// Deploy key do napp SINH RA cho từng app/service: người dùng không phải tự tạo
// key trên máy mình rồi chép private key lên server (private key không bao giờ
// rời server), chỉ việc dán PUBLIC key vào "Deploy keys" của repo.
// ---------------------------------------------------------------------------

/** Sinh cặp key ed25519 (không passphrase — deploy tự động không gõ được) BẰNG user của đơn vị. */
export function generateDeployKey(user: string, keyPath: string, comment: string): void {
  ensureUserSshDir(user);
  // ssh-keygen HỎI "Overwrite (y/n)?" nếu file đã có — xoá trước để không treo.
  runAs(user, "rm", ["-f", keyPath, `${keyPath}.pub`]);
  runAs(user, "ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath]);
  ok(`Đã sinh deploy key riêng: ${keyPath}`);
}

export function keyComment(kind: UnitKind, id: string): string {
  return `napp-${kind === "service" ? "svc-" : ""}${id}@${hostname()}`;
}

export function readPublicKey(keyPath: string): string | undefined {
  try {
    return readFileSync(`${keyPath}.pub`, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function keyFingerprint(keyPath: string): string | undefined {
  const r = execCapture("ssh-keygen", ["-l", "-f", `${keyPath}.pub`]);
  return r.code === 0 ? r.stdout.trim().split(/\s+/)[1] : undefined;
}

/** owner/repo (bỏ .git) từ URL SSH/HTTPS. */
export function repoPath(url: string): string {
  const proto = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i);
  const scp = url.match(/^[^@\s/]+@[^:\s]+:(.+)$/);
  return (proto?.[1] ?? scp?.[1] ?? "").replace(/\/+$/, "").replace(/\.git$/, "");
}

interface ProviderGuide {
  name: string;
  url?: string;
  steps: string[];
}

function providerGuide(repo: string): ProviderGuide {
  const host = repoHost(repo).toLowerCase();
  const path = repoPath(repo);
  if (host === "github.com" || host === "ssh.github.com") {
    return {
      name: "GitHub",
      url: path ? `https://github.com/${path}/settings/keys/new` : undefined,
      steps: [
        "Repo -> Settings -> Deploy keys -> Add deploy key",
        "Title: tuỳ ý (gợi ý: tên server + app)",
        "Key: dán NGUYÊN dòng public key ở trên",
        "KHÔNG tích 'Allow write access' (server chỉ cần đọc) -> Add key",
      ],
    };
  }
  if (host === "bitbucket.org") {
    return {
      name: "Bitbucket",
      url: path ? `https://bitbucket.org/${path}/admin/access-keys/` : undefined,
      steps: ["Repository settings -> Access keys -> Add key", "Label: tuỳ ý · Key: dán NGUYÊN dòng public key ở trên -> Add SSH key"],
    };
  }
  if (host.includes("gitlab")) {
    return {
      name: "GitLab",
      url: path ? `https://${host}/${path}/-/settings/repository#js-deploy-keys-settings` : undefined,
      steps: [
        "Settings -> Repository -> Deploy keys -> Add new key",
        "Title: tuỳ ý · Key: dán NGUYÊN dòng public key ở trên",
        "KHÔNG tích 'Grant write permissions to this key' -> Add key",
      ],
    };
  }
  if (host.includes("gitea") || host.includes("forgejo") || host === "codeberg.org") {
    return {
      name: "Gitea/Forgejo",
      url: path ? `https://${host}/${path}/settings/keys` : undefined,
      steps: ["Settings -> Deploy keys -> Add deploy key", "Dán NGUYÊN dòng public key ở trên, để chế độ CHỈ ĐỌC"],
    };
  }
  return {
    name: host || "máy chủ git",
    steps: ["Mở phần cài đặt của repo -> 'Deploy keys' (hoặc 'Access keys')", "Dán NGUYÊN dòng public key ở trên, quyền CHỈ ĐỌC"],
  };
}

/** In public key + các bước thêm vào repo. */
export function printDeployKeyGuide(repo: string, keyPath: string, label: string): void {
  if (execState.dryRun) {
    info(`(dry-run) Sẽ hiển thị public key ${keyPath}.pub và hướng dẫn thêm vào Deploy keys của repo.`);
    return;
  }
  const pub = readPublicKey(keyPath);
  if (!pub) die(`Không đọc được public key ${keyPath}.pub.`);
  const fp = keyFingerprint(keyPath);
  const g = providerGuide(repo);
  console.log();
  console.log(colorText("green", `  Deploy key của '${label}' — CHỈ dùng cho repo ${repoPath(repo) || repo}:`));
  console.log();
  console.log(`  ${pub}`);
  console.log();
  if (fp) console.log(`  Fingerprint: ${fp}`);
  console.log(`  Thêm public key trên vào repo (${g.name}):`);
  if (g.url) console.log(`    Mở: ${colorText("blue", g.url)}`);
  for (const [i, s] of g.steps.entries()) console.log(`    ${i + 1}. ${s}`);
  console.log(colorText("dim", "  Mỗi repo một key: GitHub/GitLab từ chối dùng lại một deploy key cho repo thứ hai. Private key nằm"));
  console.log(colorText("dim", `  trên server (${keyPath}, quyền 600) và không bao giờ cần chép đi đâu.`));
  console.log();
}

export type AccessResult = { ok: true } | { ok: false; noBranch: boolean; detail: string };

/** Thử đọc repo bằng đúng key của đơn vị (không clone, không đổi gì). */
export function checkRepoAccess(user: string, repo: string, branch: string, keyPath?: string): AccessResult {
  if (execState.dryRun) return { ok: true };
  const r = execCaptureAs(user, "git", ["ls-remote", "--exit-code", "--heads", repo, branch], { env: gitEnvFor(keyPath), timeoutMs: 60_000 });
  if (r.code === 0) return { ok: true };
  // --exit-code: 2 = kết nối + xác thực được nhưng không có ref khớp -> sai branch.
  if (r.code === 2) return { ok: false, noBranch: true, detail: `repo không có branch '${branch}'` };
  const lines = r.stderr.trim().split("\n").filter((l) => l && !/^Warning: Permanently added/.test(l));
  return { ok: false, noBranch: false, detail: lines.slice(-2).join(" / ") || `mã lỗi ${r.code}` };
}

const POLL_SECONDS = 10;

/**
 * Chờ người dùng thêm key vào repo rồi xác nhận truy cập được.
 *  - Có terminal: Enter để kiểm tra lại, 'q' để huỷ.
 *  - Không có terminal (script/CI): tự kiểm tra mỗi 10 giây tới `waitMinutes`.
 */
export async function waitForRepoAccess(user: string, repo: string, branch: string, keyPath: string, waitMinutes = 15): Promise<void> {
  if (execState.dryRun) return;
  if (process.stdin.isTTY) {
    for (;;) {
      const ans = (await ask("  Thêm key vào repo xong thì nhấn Enter để kiểm tra (gõ 'q' để huỷ): ")).trim().toLowerCase();
      if (ans === "q" || ans === "huy" || ans === "huỷ") die("Đã huỷ — repo chưa truy cập được bằng deploy key.");
      const r = checkRepoAccess(user, repo, branch, keyPath);
      if (r.ok) return void ok("Truy cập repo bằng deploy key OK.");
      if (r.noBranch) die(`Deploy key đã dùng được nhưng ${r.detail}. Kiểm tra lại --branch.`);
      warn(`Chưa đọc được repo: ${r.detail}`);
      info("Key chưa được thêm, dán thiếu ký tự, hoặc thêm nhầm repo? GitHub có thể mất vài giây để nhận key mới.");
    }
  }
  info(`Không có terminal để hỏi — tự kiểm tra lại mỗi ${POLL_SECONDS} giây, tối đa ${waitMinutes} phút...`);
  const deadline = Date.now() + waitMinutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = checkRepoAccess(user, repo, branch, keyPath);
    if (r.ok) return void ok("Truy cập repo bằng deploy key OK.");
    if (r.noBranch) die(`Deploy key đã dùng được nhưng ${r.detail}. Kiểm tra lại --branch.`);
    last = r.detail;
    execCapture("sleep", [String(POLL_SECONDS)]);
  }
  die(`Hết ${waitMinutes} phút mà vẫn chưa đọc được repo bằng deploy key (${last}).`);
}

/**
 * Lúc TẠO đơn vị với repo SSH mà không có --ssh-key: sinh key riêng, hướng dẫn
 * thêm vào repo, chờ tới khi đọc được repo. Trả về đường dẫn private key.
 */
export async function provisionDeployKey(o: { user: string; kind: UnitKind; id: string; repo: string; branch: string; keyPath: string }): Promise<string> {
  generateDeployKey(o.user, o.keyPath, keyComment(o.kind, o.id));
  printDeployKeyGuide(o.repo, o.keyPath, o.id);
  // Key vừa sinh thì chưa repo nào biết — kể cả repo public, đọc qua SSH vẫn
  // cần một key được máy chủ git chấp nhận — nên luôn phải chờ người dùng dán.
  warn("Nếu bạn huỷ ở bước này, mọi thứ vừa tạo sẽ được hoàn tác (kể cả key) — nhớ xoá key đã dán khỏi repo.");
  await waitForRepoAccess(o.user, o.repo, o.branch, o.keyPath);
  return o.keyPath;
}

export function deployKeyExists(keyPath?: string): keyPath is string {
  return Boolean(keyPath && existsSync(keyPath));
}

export interface DeployKeyOptions {
  regenerate?: boolean; // sinh key MỚI (xoay vòng / key cũ lộ / user chạy đã đổi)
}

/**
 * `napp app|service deploy-key`: hiện public key + hướng dẫn + kiểm tra truy cập.
 * Chưa có key riêng (đơn vị tạo bằng bản napp cũ) hoặc --regenerate thì sinh
 * key mới. Xoay vòng an toàn: key mới sinh ra file tạm, CHỈ thay key cũ sau khi
 * đã đọc được repo bằng key mới — huỷ giữa chừng thì deploy vẫn chạy bằng key cũ.
 * Trả về đường dẫn key đơn vị nên dùng (caller lưu vào state nếu đổi).
 */
export async function manageDeployKey(
  u: { kind: UnitKind; id: string; user: string; root: string; repo?: string; branch: string; current?: string },
  o: DeployKeyOptions
): Promise<string | undefined> {
  const cmd = u.kind === "app" ? "app" : "service";
  if (!u.repo) die(`'${u.id}' không liên kết repo git (--repo) — không cần deploy key.`);
  if (!repoIsSsh(u.repo)) {
    die(
      `Repo của '${u.id}' là HTTPS (${u.repo}) — deploy key chỉ dùng cho repo SSH.\n` +
        `  Repo HTTPS private xác thực bằng token (--token lúc tạo). Muốn chuyển sang deploy key: tạo lại ${cmd} với URL dạng git@host:owner/repo.git`
    );
  }
  const keyPath = u.current ?? deployKeyPathFor(u.user, u.kind, u.id);
  const have = existsSync(keyPath);

  if (have && !o.regenerate) {
    section(`Deploy key của ${u.id}`);
    printDeployKeyGuide(u.repo, keyPath, u.id);
    const r = checkRepoAccess(u.user, u.repo, u.branch, keyPath);
    if (r.ok) ok(`Đọc được repo bằng key này — deploy chạy bình thường.`);
    else warn(`Chưa đọc được repo bằng key này: ${r.detail}\n  Thêm public key ở trên vào repo, hoặc sinh key mới: napp ${cmd} deploy-key ${u.id} --regenerate`);
    return keyPath;
  }

  section(have ? `Sinh deploy key MỚI cho ${u.id}` : `Tạo deploy key riêng cho ${u.id}`);
  if (!u.current) info("Đơn vị này chưa có deploy key riêng (tạo bằng bản napp cũ) — sinh key riêng cho nó.");
  const tmp = have ? `${keyPath}.new` : keyPath;
  generateDeployKey(u.user, tmp, keyComment(u.kind, u.id));
  printDeployKeyGuide(u.repo, tmp, u.id);
  if (have) info("Key CŨ vẫn đang dùng cho tới khi key mới đọc được repo. Xong rồi hãy xoá key cũ khỏi Deploy keys của repo.");
  try {
    await waitForRepoAccess(u.user, u.repo, u.branch, tmp);
  } catch (e) {
    if (have) runAs(u.user, "rm", ["-f", tmp, `${tmp}.pub`], { silentFail: true }); // huỷ xoay vòng: giữ key cũ
    throw e;
  }
  if (have) {
    runAs(u.user, "mv", ["-f", tmp, keyPath]);
    runAs(u.user, "mv", ["-f", `${tmp}.pub`, `${keyPath}.pub`]);
  }
  // Ghim key vào repo để 'git pull' gõ tay bằng user này cũng dùng đúng key.
  if (existsSync(`${u.root}/.git`)) {
    runAs(u.user, "git", ["config", "core.sshCommand", sshCommandFor(keyPath)], { cwd: u.root, silentFail: true });
  }
  ok(have ? "Đã thay key mới. Nhớ XOÁ key cũ khỏi Deploy keys của repo." : `Đã gắn deploy key riêng cho '${u.id}'.`);
  return keyPath;
}

/** Một dòng cho 'show': undefined = không liên quan (không repo / repo HTTPS). */
export function deployKeyRow(kind: UnitKind, id: string, repo: string | undefined, keyPath: string | undefined): string | undefined {
  if (!repo || !repoIsSsh(repo)) return undefined;
  const cmd = `napp ${kind === "app" ? "app" : "service"} deploy-key ${id}`;
  if (!keyPath) return `chưa có key riêng (tạo bằng bản napp cũ) · tạo: ${cmd}`;
  if (!existsSync(keyPath)) return `THIẾU file ${keyPath} · sinh lại: ${cmd} --regenerate`;
  const fp = existsSync(`${keyPath}.pub`) ? keyFingerprint(keyPath) : undefined;
  return `${keyPath}${fp ? ` (${fp})` : ""} · xem public key: ${cmd}`;
}

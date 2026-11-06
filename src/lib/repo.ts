import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runAs, writeFile, execCaptureAs, state as execState } from "./exec";
import { ok, die, info } from "./log";
import { slugFor } from "./state";

// Env để MỌI thao tác git (clone/fetch) chạy KHÔNG TƯƠNG TÁC. Không bao giờ
// treo ở prompt nhập username/password (HTTPS) hay yes/no host-key (SSH): repo
// private thiếu thông tin xác thực sẽ BÁO LỖI NGAY, thay vì kẹt vô hạn ở
// /dev/tty (gõ không ăn) — vì git/ssh đọc prompt từ terminal điều khiển, mà
// tiến trình đang chạy sâu qua `sudo -u <user hệ thống>` không sở hữu terminal.
//   - GIT_TERMINAL_PROMPT=0: HTTPS thiếu credential -> fail ngay, không hỏi.
//   - BatchMode=yes: SSH không hỏi passphrase/mật khẩu.
//   - StrictHostKeyChecking=accept-new: tự thêm host key lần đầu, không hỏi yes/no.
export const GIT_NONINTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
};

// Thông tin xác thực để clone/pull repo PRIVATE. Dùng chung cho cả app (web) và
// service (chạy ngầm) — cả hai clone repo y hệt nhau.
export interface RepoAuth {
  token?: string; // Personal Access Token — clone repo PRIVATE qua HTTPS
  sshKey?: string; // deploy key (đường dẫn HOẶC nội dung) — clone repo PRIVATE qua SSH
}

export function repoIsHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function repoIsSsh(url: string): boolean {
  return /^ssh:\/\//i.test(url) || /^[^@\s]+@[^:\s]+:.+$/.test(url); // ssh:// hoặc user@host:path
}

// Rút host từ URL git để ghim credential/known-host đúng máy chủ.
export function repoHost(url: string): string {
  const proto = url.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^:/\s]+)/i); // scheme://[user@]host[:port]/...
  if (proto) return proto[1]!;
  const scp = url.match(/^[^@\s]+@([^:\s]+):/); // user@host:path
  if (scp) return scp[1]!;
  return "";
}

const KEY_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

// Nhận deploy key ở DẠNG BẤT KỲ: nội dung key dán trực tiếp (bắt đầu bằng
// '-----BEGIN ... PRIVATE KEY-----') HOẶC đường dẫn tới file key. Trả về nội
// dung key đã chuẩn hoá (đúng 1 newline cuối — OpenSSH bắt buộc).
export function resolveSshKeyMaterial(value: string): string {
  let content: string;
  if (KEY_HEADER_RE.test(value)) {
    content = value; // người dùng dán thẳng nội dung key
  } else {
    if (!existsSync(value)) {
      die(
        `Không tìm thấy file SSH deploy key: '${value}'.\n` +
          `  Hãy nhập ĐƯỜNG DẪN tới file key, HOẶC dán trực tiếp nội dung key\n` +
          `  (bắt đầu bằng '-----BEGIN ... PRIVATE KEY-----').`
      );
    }
    try {
      content = readFileSync(value, "utf8");
    } catch (e) {
      die(`Không đọc được SSH key '${value}': ${(e as Error).message}`);
    }
    if (!KEY_HEADER_RE.test(content)) {
      die(`File '${value}' không giống SSH private key (thiếu dòng '-----BEGIN ... PRIVATE KEY-----').`);
    }
  }
  if (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(content)) {
    die("SSH deploy key thiếu dòng kết '-----END ... PRIVATE KEY-----' — nội dung key có vẻ bị cắt cụt.");
  }
  return content.trim() + "\n";
}

// Xác thực tổ hợp repo + token/ssh-key TRƯỚC khi tạo tài nguyên (fail sớm, khỏi
// rollback). Nếu có --ssh-key thì RESOLVE ngay: sau lệnh này auth.sshKey là NỘI
// DUNG key đã chuẩn hoá (không còn là đường dẫn). Dùng chung cho app và service.
export function prepareRepoAuth(opts: { repo?: string; token?: string; sshKey?: string }): void {
  if ((opts.token || opts.sshKey) && !opts.repo) {
    die("--token/--ssh-key chỉ dùng kèm --repo (dùng để clone repo private).");
  }
  if (opts.token && opts.sshKey) {
    die("Chỉ chọn MỘT cách xác thực: --token (HTTPS) HOẶC --ssh-key (SSH), không dùng cả hai.");
  }
  if (opts.token) {
    if (!repoIsHttp(opts.repo!)) die("--token dùng cho repo HTTPS (https://...). Repo SSH thì dùng --ssh-key.");
    if (/[\s\x00-\x1f]/.test(opts.token)) die("Token chứa khoảng trắng/ký tự điều khiển không hợp lệ.");
  }
  if (opts.sshKey) {
    if (!repoIsSsh(opts.repo!)) die("--ssh-key dùng cho repo SSH (git@host:... hoặc ssh://...). Repo HTTPS thì dùng --token.");
    // Từ đây opts.sshKey là NỘI DUNG key đã chuẩn hoá.
    opts.sshKey = resolveSshKeyMaterial(opts.sshKey);
  }
}

// ---------------------------------------------------------------------------
// Deploy key RIÊNG cho từng app/service.
//
// Mỗi đơn vị một key (~/.ssh/napp_deploy_<slug>_<hash>), ghim vào repo qua
// core.sshCommand + GIT_SSH_COMMAND thay vì ~/.ssh/config chung. Lý do:
//  - GitHub/GitLab KHÔNG cho dùng một deploy key cho hai repo ("Key is already
//    in use") -> bắt buộc mỗi repo một key.
//  - Service '--run-as' dùng CHUNG user (và home) với app web: ghi đè
//    ~/.ssh/config/napp_deploy là cướp key của đơn vị kia, deploy của nó gãy.
// ---------------------------------------------------------------------------

export type UnitKind = "app" | "service";

/** Đường dẫn private key của đơn vị. Hash phòng slug (cắt 24 ký tự) trùng nhau. */
export function deployKeyPathFor(user: string, kind: UnitKind, id: string): string {
  const hash = createHash("sha1").update(`${kind}:${id}`).digest("hex").slice(0, 6);
  return `/home/${user}/.ssh/napp_deploy_${kind === "service" ? "svc_" : ""}${slugFor(id)}_${hash}`;
}

/** Lệnh ssh ghim đúng một key, không bao giờ hỏi gì (xem GIT_NONINTERACTIVE_ENV). */
export function sshCommandFor(keyPath: string): string {
  return `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes`;
}

/**
 * Env cho mọi lệnh git của một đơn vị. Có deploy key riêng thì ghim key đó
 * (GIT_SSH_COMMAND thắng core.sshCommand, nên phải truyền ở đây — không thì
 * env không-tương-tác chung sẽ đè mất key). Không có -> như trước (token qua
 * credential.helper, hoặc ~/.ssh/config của bản napp cũ).
 */
export function gitEnvFor(keyPath?: string): Record<string, string> {
  if (!keyPath) return GIT_NONINTERACTIVE_ENV;
  return { ...GIT_NONINTERACTIVE_ENV, GIT_SSH_COMMAND: sshCommandFor(keyPath) };
}

/** ~/.ssh của user, tạo BẰNG CHÍNH user đó (0700) — root tạo thì user không ghi được known_hosts. */
export function ensureUserSshDir(user: string): string {
  const dir = `/home/${user}/.ssh`;
  runAs(user, "mkdir", ["-p", "-m", "700", dir]);
  return dir;
}

// Chuẩn bị thông tin xác thực cho user hệ thống để clone/pull repo PRIVATE mà
// KHÔNG cần prompt. Lưu vào home của user với quyền tối thiểu nên lệnh deploy sau
// này dùng lại được, và remote vẫn là URL SẠCH (token không nhúng vào .git/config).
// Với --ssh-key: cài key vào `keyPath` (riêng của đơn vị) và trả về keyPath.
export function setupRepoAuth(user: string, repo: string, auth: RepoAuth, keyPath?: string): string | undefined {
  const home = `/home/${user}`;
  if (auth.token) {
    // credential.helper=store đọc ~/.git-credentials, khớp theo host -> token
    // nằm đúng MỘT chỗ (quyền 600), remote HTTPS giữ nguyên URL sạch.
    const host = repoHost(repo) || "github.com";
    // Tạo sẵn đúng chủ + 0600 rồi rename (xem writeFile): không 'chown' theo
    // đường dẫn trong home của app — symlink đặt sẵn ở đó sẽ kéo chown sang file của root.
    writeFile(`${home}/.git-credentials`, `https://x-access-token:${auth.token}@${host}
`, 0o600, { owner: user });
    runAs(user, "git", ["config", "--global", "credential.helper", "store"]);
    ok("Đã lưu token để clone repo private qua HTTPS (chỉ user chạy chương trình đọc được).");
    return undefined;
  }
  if (auth.sshKey && keyPath) {
    ensureUserSshDir(user);
    writeFile(keyPath, auth.sshKey, 0o600, { owner: user }); // đã resolve + chuẩn hoá ở prepareRepoAuth
    // Sinh .pub để 'deploy-key' hiển thị lại được. -P "": key có passphrase thì
    // fail ngay thay vì hỏi (key có passphrase vốn cũng không deploy tự động được).
    if (!execState.dryRun) {
      const pub = execCaptureAs(user, "ssh-keygen", ["-y", "-P", "", "-f", keyPath], { timeoutMs: 10_000 });
      if (pub.code === 0 && pub.stdout.trim()) writeFile(`${keyPath}.pub`, `${pub.stdout.trim()}\n`, 0o644, { owner: user });
    }
    ok("Đã cài deploy key để clone repo private qua SSH (chỉ user chạy chương trình đọc được).");
    return keyPath;
  }
  return undefined;
}

/**
 * Clone repo bằng user của đơn vị. Có deploy key thì ghim luôn vào
 * .git/config (core.sshCommand) để 'git pull' gõ tay bằng user đó cũng đúng key.
 */
export function cloneRepo(
  user: string,
  repo: string,
  branch: string,
  dest: string,
  o: { keyPath?: string; hadAuth: boolean; kind: UnitKind; id: string }
): void {
  info(`Đang clone ${repo} (branch ${branch})...`);
  const args = ["clone", "--branch", branch, "--depth", "1"];
  if (o.keyPath) args.push("-c", `core.sshCommand=${sshCommandFor(o.keyPath)}`);
  args.push(repo, dest);
  const clone = runAs(user, "git", args, { env: gitEnvFor(o.keyPath), silentFail: true });
  if (clone.code === 0) return;
  const cmd = o.kind === "app" ? "app" : "service";
  const privateHint = o.keyPath
    ? `
  Kiểm tra deploy key đã được thêm vào repo, và branch '${branch}' tồn tại.
  Xem lại public key: napp ${cmd} deploy-key ${o.id}`
    : !o.hadAuth
      ? `
  Nếu đây là repo PRIVATE: napp KHÔNG hỏi mật khẩu tương tác (tránh treo). Hãy:
` +
        `    - Repo SSH  : dùng URL git@host:owner/repo.git — napp tự sinh deploy key riêng và hướng dẫn thêm vào repo
` +
        `    - Repo HTTPS: thêm --token <Personal-Access-Token>`
      : `
  Kiểm tra lại token có quyền đọc repo, và branch '${branch}' tồn tại.`;
  die(`Clone repo thất bại (mã ${clone.code}). Kiểm tra URL/branch, mạng, hoặc quyền truy cập.${privateHint}`);
}

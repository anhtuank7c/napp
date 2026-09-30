import { existsSync, readFileSync } from "node:fs";
import { runCmd, runAs, ensureDir, writeFile } from "./exec";
import { ok, die } from "./log";

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

// Chuẩn bị thông tin xác thực cho user hệ thống để clone/pull repo PRIVATE mà
// KHÔNG cần prompt. Lưu vào home của user với quyền tối thiểu nên lệnh deploy sau
// này dùng lại được, và remote vẫn là URL SẠCH (token không nhúng vào .git/config).
export function setupRepoAuth(user: string, repo: string, auth: RepoAuth): void {
  const home = `/home/${user}`;
  if (auth.token) {
    // credential.helper=store đọc ~/.git-credentials, khớp theo host -> token
    // nằm đúng MỘT chỗ (quyền 600), remote HTTPS giữ nguyên URL sạch.
    const host = repoHost(repo) || "github.com";
    // Tạo sẵn đúng chủ + 0600 rồi rename (xem writeFile): không 'chown' theo
    // đường dẫn trong home của app — symlink đặt sẵn ở đó sẽ kéo chown sang file của root.
    writeFile(`${home}/.git-credentials`, `https://x-access-token:${auth.token}@${host}\n`, 0o600, { owner: user });
    runAs(user, "git", ["config", "--global", "credential.helper", "store"]);
    ok("Đã lưu token để clone repo private qua HTTPS (chỉ user chạy chương trình đọc được).");
  } else if (auth.sshKey) {
    const sshDir = `${home}/.ssh`;
    const keyPath = `${sshDir}/napp_deploy`;
    const host = repoHost(repo);
    ensureDir(sshDir, 0o700);
    writeFile(keyPath, auth.sshKey, 0o600); // đã resolve + chuẩn hoá ở prepareRepoAuth
    // ~/.ssh/config ghim deploy key + tự nhận host key -> cả clone lẫn deploy
    // dùng đúng key, không hỏi passphrase/yes-no.
    writeFile(
      `${sshDir}/config`,
      [
        host ? `Host ${host}` : "Host *",
        `  IdentityFile ${keyPath}`,
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking accept-new",
        "",
      ].join("\n"),
      0o600
    );
    runCmd("chown", ["-hR", `${user}:${user}`, sshDir]);
    ok("Đã cài deploy key để clone repo private qua SSH (chỉ user chạy chương trình đọc được).");
  }
}

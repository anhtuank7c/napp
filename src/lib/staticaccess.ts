import { existsSync, readFileSync } from "node:fs";
import { execCapture, runCmd, commandExists } from "./exec";
import { info, ok, warn } from "./log";
import type { AppRecord } from "./state";

/**
 * Cho nginx ĐỌC ĐƯỢC thư mục asset của app — phần bị thiếu khiến --static-root
 * trả 403 chứ không phải file.
 *
 * napp cô lập từng app rất chặt: thư mục mã nguồn thuộc user riêng của app
 * (na_<slug>), thư mục 750 và file 640. Tiến trình worker của nginx lại chạy
 * bằng user KHÁC (www-data trên Ubuntu). www-data không thuộc nhóm na_<slug>
 * nên nó thậm chí không đi xuyên qua được '/var/www/<domain>' — mọi request tới
 * asset tĩnh trả 403, và log lỗi của nginx ghi "Permission denied" chứ không
 * phải "No such file", một dòng rất dễ đọc lướt qua thành "sai đường dẫn".
 *
 * CÁCH VÁ Ở ĐÂY: thêm user của nginx vào NHÓM của app.
 *
 * Vì sao không phải cách khác:
 *  - chmod o+rX: mở cho MỌI user local đọc mã nguồn app, phá đúng thứ napp đang
 *    cố giữ. Trên máy nhiều người dùng/nhiều dịch vụ, đó là hạ cấp thật sự.
 *  - setfacl: chính xác hơn thật, nhưng cần gói 'acl' và filesystem bật acl —
 *    thêm một thứ có thể thiếu trên máy người dùng, đổi lại lợi ích không lớn.
 *  - Quyền NHÓM thì đã sẵn đúng rồi: napp vốn đặt thư mục 750 và file 640, tức
 *    nhóm ĐÃ có r-x/r--. Việc duy nhất còn thiếu là cho nginx vào nhóm.
 *
 * ĐÁNH ĐỔI, phải nói rõ với người dùng: sau bước này nginx đọc được toàn bộ cây
 * mã nguồn của app ở mức nhóm. Bí mật vẫn an toàn vì '.env' được chmod 600
 * (chủ sở hữu, không phải nhóm) — và nginx chỉ phục vụ đúng các tiền tố '^~' đã
 * khai báo, không có try_files chung nào đem cả cây thư mục ra đường.
 */

const DEFAULT_NGINX_USER = "www-data";

/** User mà worker nginx chạy bằng — đọc từ nginx.conf, mặc định www-data. */
export function nginxWorkerUser(): string {
  const conf = "/etc/nginx/nginx.conf";
  if (!existsSync(conf)) return DEFAULT_NGINX_USER;
  try {
    // Chỉ thị 'user <name> [group];' ở mức top-level. Bỏ qua dòng bị comment.
    const m = readFileSync(conf, "utf8").match(/^\s*user\s+([A-Za-z0-9._-]+)\s*;?/m);
    return m?.[1] ?? DEFAULT_NGINX_USER;
  } catch {
    return DEFAULT_NGINX_USER;
  }
}

/**
 * `user` có đọc được `path` không?
 *
 * Trả `null` khi KHÔNG XÁC ĐỊNH ĐƯỢC (không chạy bằng root, thiếu sudo, user
 * không tồn tại). Phân biệt null với false là quan trọng: báo "nginx không đọc
 * được" khi thật ra ta không kiểm tra nổi là một báo động giả, và người dùng sẽ
 * học cách bỏ qua cảnh báo của napp.
 *
 * Dùng `test -r -a -x`: access(2) phân giải TOÀN BỘ đường dẫn, nên nó bắt luôn
 * trường hợp thư mục cha không cho đi xuyên qua — đúng ca hỏng phổ biến nhất.
 */
export function pathReadableBy(user: string, path: string): boolean | null {
  if (process.getuid && process.getuid() !== 0) return null;
  if (!commandExists("sudo")) return null;
  if (execCapture("id", [user]).code !== 0) return null;
  // Phép thử đối chứng: '/' mọi user đều đọc/đi xuyên được. Trượt ở đây nghĩa là
  // bản thân cơ chế thử bị hỏng (sudoers chặn, thiếu /usr/bin/test), không phải
  // quyền của app sai.
  if (execCapture("sudo", ["-n", "-u", user, "test", "-r", "/", "-a", "-x", "/"]).code !== 0) return null;
  return execCapture("sudo", ["-n", "-u", user, "test", "-r", path, "-a", "-x", path]).code === 0;
}

/** nginx đã thuộc nhóm `group` chưa? null = không kiểm tra được. */
export function nginxInGroup(group: string): boolean | null {
  const nginxUser = nginxWorkerUser();
  const res = execCapture("id", ["-nG", nginxUser]);
  if (res.code !== 0) return null;
  return res.stdout.trim().split(/\s+/).includes(group);
}

export interface GrantResult {
  changed: boolean;
  message: string;
}

/**
 * Cho user của nginx vào nhóm của app, rồi RESTART nginx.
 *
 * Phải RESTART chứ không reload: quyền nhóm bổ sung được nạp lúc tiến trình
 * khởi tạo danh sách nhóm. Master nginx đang chạy giữ nguyên danh sách nhóm cũ
 * và sinh worker từ đó, nên reload xong vẫn 403 y hệt — một cái bẫy mất hàng giờ
 * để lần ra vì "đã cấp quyền rồi mà". Restart nginx làm rơi kết nối đang mở
 * trong khoảnh khắc, nên ta nói trước cho người dùng biết.
 */
export function grantNginxGroupAccess(appGroup: string): GrantResult {
  const nginxUser = nginxWorkerUser();
  const already = nginxInGroup(appGroup);
  if (already === true) return { changed: false, message: `${nginxUser} đã thuộc nhóm ${appGroup}.` };
  if (already === null) return { changed: false, message: `Không kiểm tra được nhóm của '${nginxUser}' — bỏ qua.` };
  // silentFail ở cả hai lệnh: hàm này được gọi ở CUỐI đường tạo app, sau khi app
  // đã chạy và vhost đã nạp. Để usermod thất bại kéo theo `die` là huỷ một app
  // hoàn toàn lành lặn chỉ vì phần tối ưu tĩnh — sai tỉ lệ. Hỏng thì báo, và
  // người dùng vẫn còn một app chạy được (asset đi qua Node, chậm hơn thôi).
  const add = runCmd("usermod", ["-aG", appGroup, nginxUser], { silentFail: true });
  if (add.code !== 0) return { changed: false, message: `Không thêm được '${nginxUser}' vào nhóm '${appGroup}' (mã ${add.code}).` };
  info(`Restart nginx để nạp quyền nhóm mới (reload KHÔNG đủ — danh sách nhóm chỉ đọc lúc tiến trình khởi tạo).`);
  const restart = runCmd("systemctl", ["restart", "nginx"], { silentFail: true });
  if (restart.code !== 0) {
    return { changed: true, message: `Đã thêm '${nginxUser}' vào nhóm '${appGroup}' nhưng RESTART NGINX THẤT BẠI — quyền mới chưa có hiệu lực. Chạy: sudo systemctl restart nginx` };
  }
  return { changed: true, message: `Đã thêm '${nginxUser}' vào nhóm '${appGroup}' và restart nginx.` };
}

/**
 * Mọi thư mục nginx được giao phục vụ TRỰC TIẾP từ đĩa cho một app.
 * Đúng tập hợp cần kiểm tra quyền — không thừa thư mục nào app chỉ tự đọc.
 */
export function appServePaths(app: AppRecord): string[] {
  return [app.staticRoot, ...(app.staticAliases ?? []).map((a) => a.dir), app.uploadDir].filter((p): p is string => !!p);
}

/**
 * Đảm bảo nginx đọc được mọi đường dẫn app vừa khai báo cho nó phục vụ.
 * Gọi SAU khi đã ghi cấu hình, để chỉ chạm quyền khi thật sự có gì để phục vụ.
 */
export function ensureNginxCanServe(appGroup: string, paths: string[]): void {
  const dirs = paths.filter((p) => p && existsSync(p));
  if (dirs.length === 0) return;
  const nginxUser = nginxWorkerUser();
  const unreadable = dirs.filter((d) => pathReadableBy(nginxUser, d) === false);
  if (unreadable.length === 0) return;

  warn(
    `nginx (user '${nginxUser}') KHÔNG đọc được ${unreadable.length} thư mục vừa khai báo — ` +
      `nếu để nguyên, asset tĩnh sẽ trả 403 chứ không phải file:\n` +
      unreadable.map((d) => `    ${d}`).join("\n")
  );
  const res = grantNginxGroupAccess(appGroup);
  if (res.changed) {
    ok(res.message);
    info(`nginx nay đọc được cây mã nguồn của app ở MỨC NHÓM. '.env' vẫn an toàn (chmod 600, chỉ chủ sở hữu).`);
  } else {
    warn(`${res.message} Asset tĩnh có thể vẫn trả 403 — kiểm tra bằng: sudo -u ${nginxUser} test -r ${unreadable[0]} && echo OK`);
  }
}

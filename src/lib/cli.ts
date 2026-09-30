import type { Command } from "commander";
import { colorText, die } from "./log";

// --------------------------------------------------------------------------
// Ngữ pháp lệnh của napp (xem README "Ngữ pháp lệnh"):
//
//   napp <resource> [<sub-resource>] <verb> [<id>...] [--flags]
//
// Tên lệnh CŨ vẫn chạy (lệnh ẩn) để không gãy script và — quan trọng hơn —
// không gãy các unit systemd napp đã ghi lên server ('backup run',
// 'cloudflare sync', 'mem sample'). Ba tên đó là VĨNH VIỄN; các tên cũ còn
// lại sẽ bỏ ở 2.0.
// --------------------------------------------------------------------------

function commandPath(c: Command): string {
  const parts: string[] = [];
  for (let cur: Command | null = c; cur && cur.parent; cur = cur.parent) parts.unshift(cur.name());
  return parts.join(" ");
}

/**
 * Báo tên cũ -> tên mới. CHỈ khi stderr là terminal: lệnh chạy từ systemd timer
 * hay cron không có người đọc, in ra chỉ làm bẩn journal.
 */
export function warnRenamed(oldUsage: string, newUsage: string, permanent = false): void {
  if (!process.stderr.isTTY) return;
  console.error(
    `${colorText("yellow", "[ĐÃ ĐỔI TÊN]")} 'napp ${oldUsage}' -> 'napp ${newUsage}'` +
      (permanent ? "" : " — tên cũ vẫn chạy, sẽ bỏ ở bản 2.0.")
  );
}

/**
 * Đăng ký một lệnh ẩn mang tên CŨ. `build` là cùng hàm dựng options + action
 * của lệnh mới, nên hai tên luôn nhận đúng một bộ cờ và chạy đúng một code.
 */
export function legacy(
  parent: Command,
  spec: string,
  newUsage: string,
  build: (c: Command) => Command,
  opts: { permanent?: boolean } = {}
): Command {
  const c = build(parent.command(spec, { hidden: true }));
  c.description(`(tên cũ) -> napp ${newUsage}`);
  const oldUsage = `${commandPath(parent)} ${spec.split(" ")[0]}`.trim();
  c.hook("preAction", () => warnRenamed(oldUsage, newUsage, opts.permanent));
  return c;
}

/** Lấy giá trị một cờ '--name <v>' / '--name=v' trong mảng tham số thô. */
export function rawOpt(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === name) return args[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

/**
 * Một nhóm như 'backup schedule' trước kia là lệnh LÁ ('backup schedule
 * --time 03:00' = bật lịch); nay là nhóm có 'enable | disable | show'. Hành
 * động mặc định của nhóm:
 *  - có cờ kiểu cũ -> chạy như cũ (kèm cảnh báo đổi tên);
 *  - không có gì / gõ sai lệnh con -> DỪNG với hướng dẫn, mã thoát khác 0.
 *    KHÔNG tự bật lịch: người mới gõ 'napp backup schedule' để xem có gì mà
 *    lại âm thầm tạo timer là đúng loại bất ngờ mà ngữ pháp này sinh ra để bỏ.
 */
export function legacyGroup(group: Command, legacyFlags: string[], newUsage: string, run: (args: string[]) => void | Promise<void>): Command {
  return group
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_opts: unknown, cmd: Command) => {
      const args = cmd.args;
      const path = commandPath(group);
      const subs = group.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden).map((c) => c.name());
      const stray = args.find((a) => !a.startsWith("-") && !legacyFlags.some((f) => args[args.indexOf(a) - 1] === f));
      if (stray !== undefined) die(`Lệnh con không hợp lệ: 'napp ${path} ${stray}'. Dùng: napp ${path} ${subs.join(" | ")}`);
      if (!args.some((a) => legacyFlags.some((f) => a === f || a.startsWith(`${f}=`)))) {
        die(`Thiếu lệnh con. Dùng: napp ${path} ${subs.join(" | ")}  (trước 1.28, 'napp ${path}' không kèm lệnh con = '${newUsage}')`);
      }
      warnRenamed(path, newUsage);
      await run(args);
    });
}

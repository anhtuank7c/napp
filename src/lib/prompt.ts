import * as readline from "node:readline";

// --------------------------------------------------------------------------
// MỌI câu hỏi tương tác của napp đi qua đây (menu lẫn lời xác nhận bên trong
// lệnh). Trước đây mỗi lệnh tự mở một readline riêng trên stdin trong khi menu
// vẫn giữ readline của nó, và đó là cách napp "tự tắt" không một lời:
//
//  1. Hai interface cùng đọc stdin: interface kia nuốt mất dòng trả lời, rồi
//     khi đóng nó PAUSE stdin. Không còn gì giữ event loop -> Node thoát với
//     mã 0, không lỗi, không thông báo. Người dùng chỉ thấy napp biến mất.
//  2. readline giữ terminal ở raw mode suốt vòng đời của nó — kể cả lúc lệnh
//     con (git, apt, certbot) đang chạy. Raw mode tắt ISIG: Ctrl+C không ngắt
//     được một 'git clone' đang treo, và lệnh con hỏi gì cũng không hiện chữ.
//  3. Ctrl+C / Ctrl+D ngay tại câu hỏi để lại một promise không bao giờ xong ->
//     lại rơi vào (1).
//
// Cách chữa: ở terminal, mỗi câu hỏi một interface NGẮN HẠN, đóng ngay khi có
// câu trả lời (terminal trở lại bình thường giữa các câu hỏi); Ctrl+C / Ctrl+D
// thành một lỗi có tên (PromptCancelled) để người gọi xử lý. Đầu vào không phải
// terminal (pipe) dùng MỘT bộ đọc dòng bền vững, vì đóng/mở interface giữa chừng
// làm rơi các dòng đã đọc sẵn vào bộ đệm.
// --------------------------------------------------------------------------

export class PromptCancelled extends Error {
  constructor(public readonly reason: "sigint" | "eof") {
    super(reason === "sigint" ? "Đã huỷ (Ctrl+C)." : "Đầu vào đã đóng (Ctrl+D / hết stdin).");
    this.name = "PromptCancelled";
  }
}

// --- stdin không phải terminal: một bộ đọc dòng dùng chung ------------------
let pipeReader: readline.Interface | undefined;
const pipeLines: string[] = [];
const pipeWaiters: ((line: string | null) => void)[] = [];
let pipeClosed = false;

function nextPipedLine(): Promise<string | null> {
  if (!pipeReader) {
    pipeReader = readline.createInterface({ input: process.stdin, terminal: false });
    pipeReader.on("line", (l) => {
      const w = pipeWaiters.shift();
      if (w) w(l);
      else pipeLines.push(l);
    });
    pipeReader.on("close", () => {
      pipeClosed = true;
      for (const w of pipeWaiters.splice(0)) w(null);
    });
  }
  if (pipeLines.length > 0) return Promise.resolve(pipeLines.shift()!);
  if (pipeClosed) return Promise.resolve(null);
  return new Promise((resolve) => pipeWaiters.push(resolve));
}

/**
 * Đọc một hoặc nhiều dòng trong CÙNG một interface. `more(lines)` trả true nếu
 * còn phải đọc tiếp (vd dán khối key nhiều dòng — đóng interface giữa hai dòng
 * là mất phần còn lại của lần dán).
 */
function readLines(question: string, more: (lines: string[]) => boolean): Promise<string[]> {
  if (!process.stdin.isTTY) {
    return (async () => {
      process.stdout.write(question);
      const lines: string[] = [];
      do {
        const l = await nextPipedLine();
        if (l === null) throw new PromptCancelled("eof");
        lines.push(l);
      } while (more(lines));
      return lines;
    })();
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const lines: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      rl.close(); // trả terminal về chế độ thường trước khi lệnh chạy tiếp
      fn();
    };
    rl.on("SIGINT", () => {
      process.stdout.write("^C\n");
      finish(() => reject(new PromptCancelled("sigint")));
    });
    rl.on("close", () => {
      if (settled) return;
      settled = true;
      process.stdout.write("\n");
      reject(new PromptCancelled("eof"));
    });
    rl.on("line", (l) => {
      lines.push(l.replace(/\r$/, ""));
      if (!more(lines)) finish(() => resolve(lines));
      else rl.setPrompt("");
    });
    rl.setPrompt(question);
    rl.prompt();
  });
}

/** Hỏi một dòng. Ném PromptCancelled khi Ctrl+C / Ctrl+D. */
export async function ask(question: string): Promise<string> {
  return (await readLines(question, () => false))[0] ?? "";
}

/** Hỏi có/không. Enter trống = def. */
export async function confirm(question: string, def = false): Promise<boolean> {
  const ans = (await ask(`${question} [${def ? "Y/n" : "y/N"}] `)).trim();
  if (!ans) return def;
  return /^y(es)?$/i.test(ans);
}

/** Đọc một khối nhiều dòng: dừng khi dòng CUỐI thoả `isLast` (dòng đầu không thoả `isBlock` thì chỉ đọc 1 dòng). */
export function askBlock(question: string, isBlock: (first: string) => boolean, isLast: (line: string) => boolean): Promise<string[]> {
  return readLines(question, (lines) => isBlock(lines[0]!.trim()) && !isLast(lines[lines.length - 1]!));
}

// --------------------------------------------------------------------------
// Chọn bằng phím mũi tên (↑/↓, Space, Enter) — chỉ khi stdin là terminal thật.
// Không phải terminal (pipe, script) thì quay về kiểu gõ số cũ, để tự động hoá
// và kiểm thử vẫn chạy được.
//
// Viết tay, KHÔNG thêm thư viện: napp là MỘT file chạy bằng root trên server —
// mỗi dependency là thêm một mắt xích chuỗi cung ứng cho đúng thứ napp khuyên
// người dùng cảnh giác (xem "napp doctor deps").
// --------------------------------------------------------------------------

export interface Choice<T> {
  label: string;
  value: T;
}

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const visible = (s: string) => s.replace(ANSI, "");

/** Cắt một dòng cho vừa bề ngang terminal: dòng bị xuống hàng là vẽ lại sai chỗ. */
function fit(s: string, width: number): string {
  if (visible(s).length <= width) return s;
  return visible(s).slice(0, Math.max(1, width - 1)) + "…";
}

/** Có vẽ được danh sách chọn bằng phím mũi tên không (terminal thật ở cả hai đầu). */
export function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function");
}

type KeyResult = { done: unknown } | { move: number } | { cancel: true } | undefined;

interface KeyLoopOptions {
  count: number;
  initial: number;
  render: (cursor: number) => string[];
  footer: string;
  onKey: (name: string, cursor: number) => KeyResult;
}

/**
 * Vòng đọc phím chung cho select/checkbox: vẽ tại chỗ (không cuộn màn hình),
 * nhảy bằng số, chỉ vẽ một cửa sổ khi danh sách dài hơn màn hình. LUÔN trả
 * terminal về chế độ thường khi xong — kể cả khi huỷ.
 *
 * Mọi lối ra (chọn, huỷ, Ctrl+C, Ctrl+D) đều đi qua finish(): ném lỗi thẳng từ
 * trong handler 'keypress' là lỗi KHÔNG ai bắt, và terminal kẹt ở raw mode.
 */
function keyLoop(opts: KeyLoopOptions): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const out = process.stdout;
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    out.write("\x1b[?25l"); // ẩn con trỏ trong lúc chọn
    const showCursor = () => out.write("\x1b[?25h");
    process.once("exit", showCursor);

    let cursor = Math.min(Math.max(0, opts.initial), opts.count - 1);
    let drawn = 0;
    let digits = "";
    let digitTimer: NodeJS.Timeout | undefined;

    const draw = () => {
      const width = Math.max(20, (out.columns || 80) - 1);
      const height = Math.max(5, (out.rows || 24) - 6);
      let lines = opts.render(cursor);
      // Danh sách dài hơn màn hình: chỉ vẽ một cửa sổ quanh con trỏ.
      if (lines.length > height) {
        const start = Math.min(Math.max(0, cursor - Math.floor(height / 2)), lines.length - height);
        const below = lines.length - start - height;
        lines = lines.slice(start, start + height);
        if (start) lines[0] = `  ↑ còn ${start} mục`;
        if (below) lines[lines.length - 1] = `  ↓ còn ${below} mục`;
      }
      lines = [...lines.map((l) => fit(l, width)), fit(`\x1b[2m${opts.footer}\x1b[0m`, width)];
      out.write((drawn ? `\x1b[${drawn}A\r\x1b[J` : "") + lines.join("\n") + "\n");
      drawn = lines.length;
    };

    const finish = (err: Error | undefined, value?: unknown) => {
      input.removeListener("keypress", onKeypress);
      if (digitTimer) clearTimeout(digitTimer);
      input.setRawMode(false);
      input.pause();
      if (drawn) out.write(`\x1b[${drawn}A\r\x1b[J`); // xoá danh sách; người gọi in dòng tóm tắt
      showCursor();
      process.removeListener("exit", showCursor);
      if (err) reject(err);
      else resolve(value);
    };

    const apply = (r: KeyResult): boolean => {
      if (!r) return false;
      if ("cancel" in r) {
        finish(new PromptCancelled("sigint"));
        return true;
      }
      if ("done" in r) {
        finish(undefined, r.done);
        return true;
      }
      cursor = r.move;
      return false;
    };

    const onKeypress = (str: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.ctrl && key.name === "c") return finish(new PromptCancelled("sigint"));
      if (key.ctrl && key.name === "d") return finish(new PromptCancelled("eof"));
      // Gõ số = nhảy tới mục đó (gõ 2 chữ số liền nhau cho mục >= 10).
      if (str && /^[0-9]$/.test(str)) {
        digits = digitTimer ? digits + str : str;
        if (digitTimer) clearTimeout(digitTimer);
        digitTimer = setTimeout(() => {
          digitTimer = undefined;
          digits = "";
        }, 800);
        if (apply(opts.onKey(`digit:${digits}`, cursor))) return;
        return draw();
      }
      let name = key.name ?? "";
      if (name === "k") name = "up";
      if (name === "j") name = "down";
      if (name === "up") cursor = (cursor - 1 + opts.count) % opts.count;
      else if (name === "down") cursor = (cursor + 1) % opts.count;
      else if (name === "home" || name === "pageup") cursor = 0;
      else if (name === "end" || name === "pagedown") cursor = opts.count - 1;
      else if (apply(opts.onKey(name, cursor))) return;
      draw();
    };

    input.on("keypress", onKeypress);
    draw();
  });
}

function digitTarget(name: string, count: number, zeroIndex?: number): number | undefined {
  if (!name.startsWith("digit:")) return undefined;
  const n = parseInt(name.slice(6), 10);
  if (n === 0) return zeroIndex;
  return n >= 1 && n <= count ? n - 1 : undefined;
}

const POINTER = "\x1b[36;1m❯\x1b[0m";
const highlight = (s: string) => `\x1b[36;1m${visible(s)}\x1b[0m`;

/**
 * Chọn MỘT mục bằng ↑/↓ + Enter. Esc = `escValue` nếu có (menu: quay lại),
 * không có thì là huỷ (PromptCancelled). `zeroIndex`: phím 0 nhảy tới mục này
 * (menu: "0. Quay lại" — giữ thói quen gõ 0 như trước).
 */
export async function select<T>(opts: {
  message?: string;
  choices: Choice<T>[];
  initial?: number;
  escValue?: T;
  zeroIndex?: number;
  /** In lại "› lựa chọn" sau khi chọn (mặc định: có khi có message). */
  summary?: boolean;
}): Promise<T> {
  const { choices } = opts;
  const def = Math.min(Math.max(0, opts.initial ?? 0), choices.length - 1);
  if (!interactive()) {
    // Kiểu cũ: in danh sách đánh số, gõ số hoặc gõ đúng nhãn.
    if (opts.message) console.log(opts.message);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
    const ans = (await ask(`Chọn [1-${choices.length}] (Enter = ${def + 1}): `)).trim();
    if (!ans) return choices[def]!.value;
    const n = parseInt(ans, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    if (n === 0 && opts.zeroIndex !== undefined) return choices[opts.zeroIndex]!.value;
    const byLabel = choices.find((c) => visible(c.label).toLowerCase() === ans.toLowerCase());
    if (byLabel) return byLabel.value;
    if (opts.escValue !== undefined) return opts.escValue;
    return choices[def]!.value;
  }
  if (opts.message) console.log(opts.message);
  const value = (await keyLoop({
    count: choices.length,
    initial: def,
    footer: "  ↑/↓ di chuyển · Enter chọn · gõ số để nhảy tới" + (opts.escValue !== undefined ? " · Esc quay lại" : " · Esc huỷ"),
    render: (cursor) => choices.map((c, i) => (i === cursor ? `${POINTER} ${highlight(c.label)}` : `  ${c.label}`)),
    onKey: (name, cursor) => {
      const target = digitTarget(name, choices.length, opts.zeroIndex);
      if (target !== undefined) return { move: target };
      if (name === "return" || name === "enter") return { done: choices[cursor]!.value };
      if (name === "escape") return opts.escValue !== undefined ? { done: opts.escValue } : { cancel: true };
      return undefined;
    },
  })) as T;
  if (opts.summary ?? Boolean(opts.message)) {
    const picked = choices.find((c) => c.value === value);
    if (picked) console.log(`  › ${visible(picked.label)}`);
  }
  return value;
}

/**
 * Chọn NHIỀU mục: ↑/↓ di chuyển, Space tick/bỏ tick, 'a' tick/bỏ tất cả, Enter
 * xác nhận, Esc huỷ (PromptCancelled).
 */
export async function checkbox<T>(opts: { message: string; choices: (Choice<T> & { checked: boolean })[] }): Promise<T[]> {
  const checked = opts.choices.map((c) => c.checked);
  if (!interactive()) {
    // Kiểu cũ: gõ các số để đảo trạng thái, Enter trống = xác nhận.
    while (true) {
      console.log(opts.message);
      opts.choices.forEach((c, i) => console.log(`  ${i + 1}. [${checked[i] ? "x" : " "}] ${c.label}`));
      const ans = (await ask("Gõ số để bật/tắt (cách nhau bởi dấu cách/phẩy), Enter = xác nhận: ")).trim();
      if (!ans) return opts.choices.filter((_, i) => checked[i]).map((c) => c.value);
      for (const tok of ans.split(/[\s,]+/).filter(Boolean)) {
        const n = parseInt(tok, 10);
        if (Number.isInteger(n) && n >= 1 && n <= opts.choices.length) checked[n - 1] = !checked[n - 1];
      }
      console.log();
    }
  }
  console.log(opts.message);
  await keyLoop({
    count: opts.choices.length,
    initial: 0,
    footer: "  ↑/↓ di chuyển · Space chọn/bỏ · a = chọn/bỏ tất cả · Enter xác nhận · Esc huỷ",
    render: (cursor) =>
      opts.choices.map((c, i) => {
        const box = checked[i] ? "\x1b[32m[x]\x1b[0m" : "[ ]";
        return i === cursor ? `${POINTER} ${box} ${highlight(c.label)}` : `  ${box} ${c.label}`;
      }),
    onKey: (name, cursor) => {
      const target = digitTarget(name, opts.choices.length);
      if (target !== undefined) return { move: target };
      if (name === "space") {
        checked[cursor] = !checked[cursor];
        return { move: cursor };
      }
      if (name === "a") {
        checked.fill(!checked.every(Boolean));
        return { move: cursor };
      }
      if (name === "return" || name === "enter") return { done: true };
      if (name === "escape") return { cancel: true };
      return undefined;
    },
  });
  const picked = opts.choices.filter((_, i) => checked[i]);
  console.log(`  › ${picked.length ? picked.map((c) => visible(c.label)).join(", ") : "(không chọn gì)"}`);
  return picked.map((c) => c.value);
}

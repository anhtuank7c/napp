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

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { NAPP_ROOT } from "./state";
import { writeFile } from "./exec";

// --------------------------------------------------------------------------
// Gửi thông báo ra ngoài (hiện tại: Telegram).
//
// NGUYÊN TẮC CÁCH LY: việc gửi LUÔN chạy trong một TIẾN TRÌNH CON riêng
// ('napp notify deliver'), tiến trình cha chỉ chờ kết quả có giới hạn thời gian:
//   - Telegram sập, DNS treo, TLS kẹt, token sai, bị chặn mạng... -> con thoát
//     với lỗi hoặc bị GIẾT (SIGKILL) khi quá hạn; cha ghi nhận lỗi rồi đi tiếp.
//   - Lỗi bất ngờ trong mã gửi (exception, rò bộ nhớ, vòng lặp) chết cùng tiến
//     trình con, không lan sang lần quét đang chạy.
//   - sendIsolated() KHÔNG BAO GIỜ ném lỗi — trả { ok:false, error } thay vì.
// Thêm một lớp nữa ở systemd: unit quét chạy với MemoryMax, CPUQuota, TimeoutStartSec
// (templates/systemd.ts) — kể cả napp có lỗi tệ nhất cũng không chiếm được máy.
//
// Bí mật: token KHÔNG đi qua argv/biến môi trường của tiến trình con (ai cũng
// đọc được qua 'ps' / /proc/<pid>/cmdline). Con tự đọc từ file 0600 của root,
// hoặc nhận qua stdin (pipe riêng giữa cha và con) khi gửi thử trước lúc lưu.
// --------------------------------------------------------------------------

export const NOTIFY_CONFIG_PATH = `${NAPP_ROOT}/notify.json`;
const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_MAX_CHARS = 4096;
const ATTEMPT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
// Hạn chót cho CẢ tiến trình con (3 lần thử x 10s + chờ giữa các lần, có dư).
// Quá hạn là SIGKILL, không thương lượng.
const CHILD_HARD_TIMEOUT_MS = 60_000;

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export interface NotifyConfig {
  telegram?: TelegramConfig;
}

// Token của BotFather: <số bot>:<35 ký tự base64url>. Kiểm định dạng để bắt lỗi
// dán thiếu/dư ký tự NGAY lúc cấu hình, và để token không thể chứa '/', '?'...
// làm lệch đường dẫn URL gọi API.
export const TELEGRAM_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,50}$/;
// chat_id: số (âm với group/channel) hoặc @tên_kênh_công_khai.
export const TELEGRAM_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export function loadNotifyConfig(): NotifyConfig {
  try {
    if (!existsSync(NOTIFY_CONFIG_PATH)) return {};
    const c = JSON.parse(readFileSync(NOTIFY_CONFIG_PATH, "utf8")) as NotifyConfig;
    const t = c?.telegram;
    if (t && (typeof t.token !== "string" || typeof t.chatId !== "string" || !TELEGRAM_TOKEN_RE.test(t.token) || !TELEGRAM_CHAT_RE.test(t.chatId))) {
      return {}; // file bị sửa tay sai định dạng -> coi như chưa cấu hình
    }
    return c ?? {};
  } catch {
    return {};
  }
}

export function saveNotifyConfig(c: NotifyConfig): void {
  // 0600 root: token bot cho phép BẤT KỲ AI gửi tin nhân danh bot, đọc tin nhắn
  // gửi tới bot — là bí mật ngang mật khẩu.
  writeFile(NOTIFY_CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", 0o600);
}

export function maskToken(token: string): string {
  const [id, secret] = token.split(":");
  return `${id}:${(secret ?? "").slice(0, 4)}…${(secret ?? "").slice(-2)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Cắt cho vừa giới hạn 4096 ký tự của Telegram, ở ranh giới dòng để không cắt
// đôi một thẻ HTML (Telegram từ chối CẢ tin nhắn nếu HTML hỏng).
export function fitTelegram(html: string): string {
  if (html.length <= TELEGRAM_MAX_CHARS) return html;
  const tail = "\n… (đã cắt bớt — xem đầy đủ: sudo napp doctor)";
  const cut = html.slice(0, TELEGRAM_MAX_CHARS - tail.length);
  return cut.slice(0, Math.max(0, cut.lastIndexOf("\n"))) + tail;
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  permanent?: boolean; // lỗi cấu hình (token/chat sai) — thử lại cũng vô ích
}

// ---------------------------------------------------------------- con ---
// Chạy TRONG tiến trình con. Có thể ném lỗi thoải mái — cha chỉ đọc kết quả.
async function deliverTelegram(cfg: TelegramConfig, html: string): Promise<DeliveryResult> {
  const redact = (s: string) => s.split(cfg.token).join("<token>");
  let last: DeliveryResult = { ok: false, error: "chưa thử lần nào" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text: fitTelegram(html), parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
      if (res.ok && body.ok) return { ok: true };
      const desc = redact(`HTTP ${res.status}${body.description ? ` — ${body.description}` : ""}`);
      // 400 (chat not found, HTML hỏng), 401 (token sai), 403 (bot bị chặn /
      // chưa được thêm vào group), 404: lỗi cấu hình — dừng ngay.
      if ([400, 401, 403, 404].includes(res.status)) return { ok: false, error: desc, permanent: true };
      last = { ok: false, error: desc };
      if (res.status === 429 && body.parameters?.retry_after) {
        await sleep(Math.min(body.parameters.retry_after, 15) * 1000);
        continue;
      }
    } catch (e) {
      last = { ok: false, error: redact((e as Error).name === "TimeoutError" ? `hết thời gian chờ ${ATTEMPT_TIMEOUT_MS / 1000}s` : String((e as Error).message ?? e)) };
    }
    if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
  }
  return last;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Điểm vào của tiến trình con ('napp notify deliver'): đọc tin nhắn từ stdin, in một dòng JSON kết quả. */
export async function cmdNotifyDeliver(): Promise<void> {
  let result: DeliveryResult;
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { html: string; telegram?: TelegramConfig };
    const html = payload.html;
    // Cấu hình đi kèm trong stdin (gửi thử TRƯỚC khi lưu) phải qua đúng bộ kiểm như file.
    const t = payload.telegram;
    const cfg = t && TELEGRAM_TOKEN_RE.test(t.token) && TELEGRAM_CHAT_RE.test(t.chatId) ? t : loadNotifyConfig().telegram;
    result = !cfg ? { ok: false, error: "chưa cấu hình Telegram", permanent: true } : await deliverTelegram(cfg, String(html));
  } catch (e) {
    result = { ok: false, error: `lỗi trong tiến trình gửi: ${(e as Error).message}` };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

// ---------------------------------------------------------------- cha ---
/**
 * Gửi tin qua tiến trình con, chờ tối đa CHILD_HARD_TIMEOUT_MS. KHÔNG BAO GIỜ
 * ném lỗi, KHÔNG BAO GIỜ treo quá hạn chót — mọi sự cố đều thành { ok:false }.
 */
export function sendIsolated(html: string, telegram?: TelegramConfig): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: DeliveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // process.argv[1] = chính file napp đang chạy (/usr/local/bin/napp).
      child = spawn(process.execPath, [process.argv[1] ?? "", "notify", "deliver"], {
        stdio: ["pipe", "pipe", "pipe"],
        // Giới hạn heap của con: một phản hồi bất thường cũng không phình được bộ nhớ.
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=64" },
      });
    } catch (e) {
      resolve({ ok: false, error: `không tạo được tiến trình gửi: ${(e as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: `tiến trình gửi quá ${CHILD_HARD_TIMEOUT_MS / 1000}s — đã buộc dừng` });
    }, CHILD_HARD_TIMEOUT_MS);

    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out = (out + d).slice(-8192)));
    // Giữ PHẦN ĐẦU stderr: dòng lỗi thật ("FATAL ERROR: ... out of memory") đứng
    // đầu, theo sau là stack trace dài hàng chục dòng.
    child.stderr?.on("data", (d) => {
      if (err.length < 4096) err = (err + d).slice(0, 4096);
    });
    child.on("error", (e) => done({ ok: false, error: `tiến trình gửi lỗi: ${e.message}` }));
    child.on("close", (code, signal) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        const r = JSON.parse(line) as DeliveryResult;
        if (typeof r.ok === "boolean") return done(r);
      } catch {
        /* rơi xuống dưới */
      }
      // Dòng có ích nhất của stderr: dòng báo lỗi ("Error: ...", "FATAL ERROR: ...
      // heap out of memory"), không phải dòng cuối (thường là "Node.js v24.x").
      const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
      const why = lines.find((l) => /FATAL ERROR|^\w*Error\b|^Error:/.test(l)) ?? lines[0];
      done({ ok: false, error: `tiến trình gửi thoát bất thường (code ${code ?? "?"}${signal ? `, ${signal}` : ""})${why ? `: ${why.slice(0, 200)}` : ""}` });
    });
    // Con chết sớm thì ghi stdin sẽ EPIPE — nuốt lỗi, 'close' ở trên lo kết quả.
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ html, telegram }));
  });
}

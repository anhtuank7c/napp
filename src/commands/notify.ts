import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { requireRoot, runCmd, writeFile } from "../lib/exec";
import { info, ok, warn, danger, section, step, die, colorText } from "../lib/log";
import { askSecret, ask } from "../lib/prompt";
import { isCriticalPackage } from "../lib/apt";
import { nodeLifecycle } from "../lib/cve";
import { SYSTEMD_DIR } from "../lib/state";
import { writeManagedUnit } from "../lib/unitfile";
import { showTimer } from "../lib/timer";
import type { Severity } from "../lib/deps";
import { renderDoctorWatchService, renderDoctorWatchTimer } from "../templates/systemd";
import {
  loadNotifyConfig,
  saveNotifyConfig,
  sendIsolated,
  maskToken,
  escapeHtml,
  NOTIFY_CONFIG_PATH,
  TELEGRAM_TOKEN_RE,
  TELEGRAM_CHAT_RE,
  type TelegramConfig,
} from "../lib/notify";
import { collectSystemReport, nginxCveReport, allTargets, scanKnownVulns } from "./doctor";
import { cveLabel } from "../lib/osv";

// --------------------------------------------------------------------------
// Thông báo + quét bảo mật định kỳ.
//   napp notify telegram|test|show|remove   : cấu hình kênh nhận thông báo
//   napp doctor watch enable|disable|show    : systemd timer quét hằng ngày
//   napp doctor watch run                    : lệnh timer chạy (quét -> gửi)
// Lần quét gồm: bản vá hệ thống, dịch vụ chưa restart, CVE Node.js + nginx,
// lỗ hổng NGHIÊM TRỌNG/CAO và mã độc trong dependencies của từng app (OSV.dev).
//
// Chống spam: chỉ gửi khi có vấn đề MỚI so với lần gửi trước, hoặc vấn đề cũ
// vẫn còn sau ~1 ngày (nhắc lại). Hết vấn đề thì báo "đã sạch" MỘT lần rồi im.
// Một kênh thông báo kêu liên tục sẽ bị tắt tiếng — và khi đó lỗi thật cũng
// không ai đọc.
// --------------------------------------------------------------------------

const NAPP_BIN_PATH = "/usr/local/bin/napp";
const WATCH_TIMER_NAME = "napp-doctor-watch";
const NOTIFY_STATE_PATH = "/var/lib/napp/notify-state.json";
const REMIND_AFTER_MS = 20 * 3_600_000; // < 24h: timer hằng ngày có lệch ngẫu nhiên tới 10 phút

// ------------------------------------------------------------ cấu hình ---

export async function cmdNotifyTelegram(opts: { token?: string; chat?: string; verify: boolean }): Promise<void> {
  requireRoot();
  section("Cấu hình thông báo Telegram");
  let token = opts.token?.trim();
  if (!token) {
    info("Tạo bot: nhắn /newbot cho @BotFather trên Telegram, nhận token dạng 123456789:AA...");
    token = (await askSecret("Bot token (không hiện khi gõ): ")).trim();
  }
  if (!TELEGRAM_TOKEN_RE.test(token)) die("Token không đúng định dạng của BotFather (<số>:<35 ký tự>). Kiểm tra đã dán đủ, không thừa khoảng trắng.");

  let chatId = opts.chat?.trim();
  if (!chatId) {
    info(
      "Lấy chat ID: nhắn một tin bất kỳ cho bot (hoặc thêm bot vào group rồi nhắn trong group), sau đó mở\n" +
        "       https://api.telegram.org/bot<token>/getUpdates  — số ở \"chat\":{\"id\": ...} là chat ID (group là số âm)."
    );
    chatId = (await ask("Chat ID: ")).trim();
  }
  if (!TELEGRAM_CHAT_RE.test(chatId)) die("Chat ID phải là số (group/channel là số âm) hoặc @tên_kênh.");

  const cfg: TelegramConfig = { token, chatId };
  if (opts.verify) {
    info("Đang gửi tin thử (qua tiến trình riêng, tối đa 60 giây)...");
    const r = await sendIsolated(testMessage("Đã kết nối napp với Telegram."), cfg);
    if (!r.ok && r.permanent) {
      die(`Telegram từ chối: ${r.error}\n       Chưa lưu gì. Kiểm tra token / chat ID (bot đã được nhắn trước, hoặc đã được thêm vào group?).`);
    }
    if (!r.ok) warn(`Chưa gửi được (${r.error}) — có thể do mạng/Telegram tạm lỗi. Vẫn lưu cấu hình; thử lại: sudo napp notify test`);
    else ok("Đã gửi tin thử — kiểm tra Telegram.");
  }
  saveNotifyConfig({ ...loadNotifyConfig(), telegram: cfg });
  ok(`Đã lưu ${NOTIFY_CONFIG_PATH} (quyền 0600, chỉ root đọc được).`);
  if (!existsSync(`${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.timer`)) info("Bật quét hằng ngày + gửi thông báo: sudo napp doctor watch enable");
}

function testMessage(line: string): string {
  return `✅ <b>napp — ${escapeHtml(hostname())}</b>\n${escapeHtml(line)}`;
}

export async function cmdNotifyTest(): Promise<void> {
  requireRoot();
  const cfg = loadNotifyConfig().telegram;
  if (!cfg) die("Chưa cấu hình Telegram. Chạy: sudo napp notify telegram");
  info(`Đang gửi tin thử tới chat ${cfg.chatId} (qua tiến trình riêng, tối đa 60 giây)...`);
  const r = await sendIsolated(testMessage(`Tin thử lúc ${new Date().toLocaleString("vi-VN")}.`));
  recordDelivery(r.ok, r.error);
  if (r.ok) ok("Đã gửi — kiểm tra Telegram.");
  else danger(`Gửi thất bại: ${r.error}${r.permanent ? "  (lỗi cấu hình — sửa bằng: sudo napp notify telegram)" : ""}`);
}

export function cmdNotifyShow(): void {
  section("Thông báo");
  const cfg = loadNotifyConfig().telegram;
  if (!cfg) info("Telegram: chưa cấu hình  ->  sudo napp notify telegram");
  else ok(`Telegram: bot ${maskToken(cfg.token)} -> chat ${cfg.chatId}`);
  const st = loadNotifyState();
  if (st.lastDelivery) {
    const d = st.lastDelivery;
    (d.ok ? info : warn)(`Lần gửi gần nhất: ${d.at} — ${d.ok ? "thành công" : `THẤT BẠI: ${d.error}`}`);
  }
  if (st.lastKeys?.length) info(`Đang theo dõi ${st.lastKeys.length} vấn đề chưa xử lý (từ lần quét gần nhất).`);
  showTimer("Quét bảo mật định kỳ", WATCH_TIMER_NAME, "sudo napp doctor watch enable");
}

export function cmdNotifyRemove(): void {
  requireRoot();
  const c = loadNotifyConfig();
  delete c.telegram;
  saveNotifyConfig(c);
  ok("Đã xoá cấu hình Telegram.");
  if (existsSync(`${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.timer`)) info("Timer quét vẫn chạy (kết quả vào journal). Tắt hẳn: sudo napp doctor watch disable");
}

// ----------------------------------------------------- trạng thái gửi ---

interface NotifyState {
  lastKeys?: string[]; // vấn đề đã báo ở lần gửi THÀNH CÔNG gần nhất
  lastSentAt?: string;
  lastDelivery?: { at: string; ok: boolean; error?: string };
}

function loadNotifyState(): NotifyState {
  try {
    const s = JSON.parse(readFileSync(NOTIFY_STATE_PATH, "utf8")) as NotifyState;
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

function saveNotifyState(s: NotifyState): void {
  try {
    writeFile(NOTIFY_STATE_PATH, JSON.stringify(s) + "\n", 0o600);
  } catch {
    /* trạng thái chỉ để chống spam — ghi hỏng thì lần sau gửi lại, không sao */
  }
}

function recordDelivery(okd: boolean, error?: string): void {
  const s = loadNotifyState();
  s.lastDelivery = { at: new Date().toISOString(), ok: okd, ...(error ? { error } : {}) };
  saveNotifyState(s);
}

// -------------------------------------------------------------- quét ---

interface Finding {
  key: string; // định danh ỔN ĐỊNH qua các lần quét — để biết vấn đề nào là MỚI
  group: string;
  severity: Severity;
  text: string;
}

// Mỗi phần quét bọc riêng: một phần hỏng (nginx -T lỗi, mạng...) thành một
// phát hiện "không quét được", không làm mất cả bản báo cáo.
async function collectFindings(): Promise<Finding[]> {
  const out: Finding[] = [];
  const guard = async (group: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      out.push({ key: `scan-error:${group}`, group, severity: "medium", text: `Không quét được: ${(e as Error).message}` });
    }
  };

  const report = await collectSystemReport({ refresh: true }).catch((e: Error) => {
    out.push({ key: "scan-error:system", group: "Hệ thống", severity: "medium", text: `Không quét được bản vá hệ thống: ${e.message}` });
    return undefined;
  });

  if (report) {
    await guard("Hệ thống", () => {
      const critical = report.security.filter((p) => isCriticalPackage(p.pkg));
      for (const p of critical) {
        out.push({ key: `apt:${p.pkg}:${p.newVersion}`, group: "Bản vá hệ thống", severity: "high", text: `${p.pkg} ${p.currentVersion} → ${p.newVersion}` });
      }
      const rest = report.security.length - critical.length;
      if (rest > 0) {
        const ver = report.security.filter((p) => !isCriticalPackage(p.pkg)).map((p) => `${p.pkg}=${p.newVersion}`).sort().join(",");
        out.push({ key: `apt-other:${ver}`, group: "Bản vá hệ thống", severity: "medium", text: `${rest} gói khác có bản vá bảo mật đang chờ` });
      }
      for (const s of report.staleUnits) {
        out.push({ key: `stale:${s.unit}`, group: "Chưa khởi động lại", severity: "high", text: `${s.unit} vẫn chạy mã cũ (${s.libs.slice(0, 2).join(", ")})` });
      }
      if (report.reboot.required) out.push({ key: "reboot", group: "Hệ thống", severity: "medium", text: "Máy cần khởi động lại để bản vá kernel/libc có hiệu lực" });
    });

    await guard("Node.js", () => {
      const node = report.node;
      if (!node) return;
      const life = nodeLifecycle(node.version, new Date(), node.feed.eol);
      if (life.eol) out.push({ key: `node-eol:${life.major}`, group: "Node.js", severity: "critical", text: `Node.js ${node.version} đã HẾT HỖ TRỢ — không còn bản vá nào` });
      for (const a of node.affected) {
        out.push({ key: `node:${node.version}:${a.advisory.id}`, group: "Node.js", severity: a.advisory.severity, text: `${a.advisory.id} — ${a.reason}` });
      }
    });
  }

  // Dependencies: chỉ mức NGHIÊM TRỌNG/CAO và mã độc — mức thấp hằng ngày là
  // tiếng ồn, xem đủ bằng 'napp doctor deps'.
  for (const t of allTargets()) {
    const group = `Dependencies · ${t.label}`;
    await guard(group, async () => {
      const known = await scanKnownVulns(t);
      if (known.osv) {
        for (const h of known.osv.hits) {
          if (!h.malicious && h.severity !== "critical" && h.severity !== "high") continue;
          out.push({
            key: `dep:${t.label}:${h.name}@${h.version}:${h.id}`,
            group,
            severity: h.severity,
            text: h.malicious
              ? `MÃ ĐỘC ${h.name}@${h.version} (${h.id}) — gỡ ngay, xoay vòng bí mật của app`
              : `${h.name}@${h.version} ${cveLabel(h)} — ${h.fixed ? `vá ở ${h.fixed}` : "chưa có bản vá"}`,
          });
        }
      } else {
        // Đã lùi về audit của package manager: chỉ có bản tóm tắt theo dự án.
        for (const f of known.findings.filter((x) => x.severity === "critical" || x.severity === "high")) {
          out.push({ key: `dep:${t.label}:${f.title}`, group, severity: f.severity, text: f.title });
        }
      }
    });
  }

  await guard("nginx", () => {
    const nginx = nginxCveReport();
    for (const a of nginx?.assessments.filter((x) => x.verdict === "affected") ?? []) {
      out.push({ key: `nginx:${a.cve.id}`, group: "nginx", severity: a.cve.severity, text: `${a.cve.id} — ${a.cve.summary}` });
    }
  });

  return out;
}

const SEV_ICON: Record<Severity, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" };
const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function formatFindings(host: string, findings: Finding[], newKeys: Set<string>): string {
  const worst = findings.reduce<Severity>((w, f) => (SEV_RANK[f.severity] < SEV_RANK[w] ? f.severity : w), "info");
  const lines = [
    `${SEV_ICON[worst]} <b>napp doctor — ${escapeHtml(host)}</b>`,
    `${findings.length} vấn đề bảo mật${newKeys.size ? ` (${newKeys.size} mới 🆕)` : " (chưa xử lý từ lần trước)"}`,
  ];
  const groups = [...new Set(findings.map((f) => f.group))];
  for (const g of groups) {
    lines.push("", `<b>${escapeHtml(g)}</b>`);
    const items = findings.filter((f) => f.group === g).sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    for (const f of items.slice(0, 10)) lines.push(`${newKeys.has(f.key) ? "🆕 " : ""}${SEV_ICON[f.severity]} ${escapeHtml(f.text)}`);
    if (items.length > 10) lines.push(`… và ${items.length - 10} mục nữa`);
  }
  lines.push("", "Chi tiết: <code>sudo napp doctor</code>", "Vá: <code>sudo napp doctor upgrade</code>");
  return lines.join("\n");
}

/** Lệnh timer chạy. Không bao giờ thoát lỗi vì kênh thông báo hỏng — chỉ ghi lại. */
export async function cmdDoctorWatchRun(): Promise<void> {
  requireRoot();
  const findings = await collectFindings();
  const state = loadNotifyState();
  const prev = new Set(state.lastKeys ?? []);
  const keys = findings.map((f) => f.key);
  const newKeys = new Set(keys.filter((k) => !prev.has(k)));
  const host = hostname();

  // Ghi vào journal trước tiên — kể cả không có kênh thông báo, 'journalctl -u
  // napp-doctor-watch' vẫn có lịch sử đầy đủ.
  console.log(`napp doctor watch: ${findings.length} vấn đề (${newKeys.size} mới)`);
  for (const f of findings) console.log(`  [${f.severity}] ${f.group}: ${f.text}${newKeys.has(f.key) ? " (mới)" : ""}`);

  let html: string | undefined;
  if (findings.length > 0) {
    const stale = !state.lastSentAt || Date.now() - new Date(state.lastSentAt).getTime() > REMIND_AFTER_MS;
    if (newKeys.size > 0 || stale) html = formatFindings(host, findings, newKeys);
  } else if (prev.size > 0) {
    html = `✅ <b>napp doctor — ${escapeHtml(host)}</b>\nĐã xử lý hết ${prev.size} vấn đề bảo mật của lần trước. Không còn gì cần làm.`;
  }
  if (!html) {
    console.log("Không có gì mới để báo.");
    return;
  }

  if (!loadNotifyConfig().telegram) {
    console.log("Chưa cấu hình kênh thông báo (sudo napp notify telegram) — kết quả chỉ nằm trong journal.");
    return;
  }
  const r = await sendIsolated(html);
  recordDelivery(r.ok, r.error);
  if (r.ok) {
    // Chỉ ghi nhớ "đã báo" khi gửi THÀNH CÔNG: gửi hỏng thì lần sau các vấn
    // đề này vẫn được tính là mới và gửi lại.
    saveNotifyState({ ...loadNotifyState(), lastKeys: keys, lastSentAt: new Date().toISOString() });
    console.log("Đã gửi thông báo Telegram.");
  } else {
    console.log(`Gửi thông báo Telegram THẤT BẠI: ${r.error} — sẽ thử lại ở lần quét sau.`);
  }
}

// ------------------------------------------------------------- timer ---

export function cmdDoctorWatchEnable(opts: { at: string }): void {
  requireRoot();
  const m = opts.at.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) die(`--at phải có dạng HH:MM (vd 07:00), nhận được: ${opts.at}`);
  const onCalendar = `*-*-* ${m[1]!.padStart(2, "0")}:${m[2]}:00`;
  writeManagedUnit(`${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.service`, renderDoctorWatchService(NAPP_BIN_PATH), { authoritative: ["ExecStart"] });
  writeFile(`${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.timer`, renderDoctorWatchTimer(onCalendar), 0o644);
  runCmd("systemctl", ["daemon-reload"]);
  runCmd("systemctl", ["enable", "--now", `${WATCH_TIMER_NAME}.timer`]);
  ok(`Đã bật quét bảo mật hằng ngày lúc ${m[1]!.padStart(2, "0")}:${m[2]} (lệch ngẫu nhiên tối đa 10 phút).`);
  step("Gửi thông báo khi có vấn đề MỚI, nhắc lại mỗi ngày nếu chưa xử lý, báo một lần khi đã sạch.");
  step(`Job chạy với giới hạn: tối đa 50% một nhân CPU, 768 MB RAM, 20 phút — không ảnh hưởng app.`);
  step(`Nhật ký: journalctl -u ${WATCH_TIMER_NAME} -n 50`);
  step(`Chạy thử ngay: sudo systemctl start ${WATCH_TIMER_NAME}.service`);
  if (!loadNotifyConfig().telegram) warn("Chưa cấu hình Telegram — kết quả chỉ nằm trong journal. Cấu hình: sudo napp notify telegram");
}

export function cmdDoctorWatchDisable(): void {
  requireRoot();
  runCmd("systemctl", ["disable", "--now", `${WATCH_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("rm", ["-f", `${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.service`, `${SYSTEMD_DIR}/${WATCH_TIMER_NAME}.timer`], { silentFail: true });
  runCmd("systemctl", ["daemon-reload"]);
  ok("Đã tắt quét bảo mật định kỳ.");
}

export function cmdDoctorWatchShow(): void {
  cmdNotifyShow();
  console.log(colorText("dim", `  Nhật ký: journalctl -u ${WATCH_TIMER_NAME} -n 50`));
}

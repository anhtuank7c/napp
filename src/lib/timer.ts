import { existsSync, readFileSync } from "node:fs";
import { execCapture, isServiceEnabled } from "./exec";
import { ok, info, section } from "./log";
import { SYSTEMD_DIR } from "./state";

export interface TimerState {
  exists: boolean;
  enabled: boolean;
  schedule?: string; // mô tả dễ đọc: "hàng ngày 03:00", "mỗi 15 phút"
  next?: string;
}

// OnCalendar -> tiếng người. Chỉ cần hiểu đúng các dạng napp tự ghi ra.
function describeCalendar(cal: string): string {
  const daily = cal.match(/^\*-\*-\* (\d{2}:\d{2}):00$/);
  if (daily) return `hàng ngày ${daily[1]}`;
  const minutes = cal.match(/^\*:0\/(\d+)$/);
  if (minutes) return `mỗi ${minutes[1]} phút`;
  if (cal === "hourly") return "mỗi giờ";
  const hours = cal.match(/^\*-\*-\* 0\/(\d+):00:00$/);
  if (hours) return `mỗi ${hours[1]} giờ`;
  return cal;
}

/** Trạng thái ngắn gọn của một timer — để vẽ nhãn [BẬT]/[TẮT] trong menu. */
export function timerState(timerName: string): TimerState {
  const timerPath = `${SYSTEMD_DIR}/${timerName}.timer`;
  if (!existsSync(timerPath)) return { exists: false, enabled: false };
  const calendar = readFileSync(timerPath, "utf8").match(/^OnCalendar=(.*)$/m)?.[1];
  const next = execCapture("systemctl", ["show", `${timerName}.timer`, "-p", "NextElapseUSecRealtime", "--value"]).stdout.trim();
  return {
    exists: true,
    enabled: isServiceEnabled(`${timerName}.timer`),
    schedule: calendar ? describeCalendar(calendar) : undefined,
    next: next || undefined,
  };
}

/** Trạng thái một timer napp tạo (backup, đồng bộ Cloudflare, lấy mẫu bộ nhớ) — cho các lệnh '... show'. */
export function showTimer(label: string, timerName: string, enableHint: string): void {
  section(label);
  const timerPath = `${SYSTEMD_DIR}/${timerName}.timer`;
  if (!existsSync(timerPath)) {
    info(`Chưa bật. Bật bằng: ${enableHint}`);
    return;
  }
  const enabled = isServiceEnabled(`${timerName}.timer`);
  const props = execCapture("systemctl", ["show", `${timerName}.timer`, "-p", "NextElapseUSecRealtime", "-p", "LastTriggerUSec", "--value"]).stdout
    .trim()
    .split("\n");
  const calendar = readFileSync(timerPath, "utf8").match(/^OnCalendar=(.*)$/m)?.[1];
  const servicePath = `${SYSTEMD_DIR}/${timerName}.service`;
  const execStart = existsSync(servicePath) ? readFileSync(servicePath, "utf8").match(/^ExecStart=(.*)$/m)?.[1] : undefined;
  (enabled ? ok : info)(enabled ? "Đang bật" : "Có file timer nhưng ĐANG TẮT");
  if (calendar) console.log(`  Lịch       : ${calendar}`);
  if (props[0]) console.log(`  Lần tới    : ${props[0]}`);
  if (props[1]) console.log(`  Lần trước  : ${props[1]}`);
  if (execStart) console.log(`  Chạy lệnh  : ${execStart}`);
}

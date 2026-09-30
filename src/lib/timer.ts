import { existsSync, readFileSync } from "node:fs";
import { execCapture, isServiceEnabled } from "./exec";
import { ok, info, section } from "./log";
import { SYSTEMD_DIR } from "./state";

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

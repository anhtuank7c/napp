import readline from "node:readline/promises";
import { cmdCheck } from "./check";
import { cmdAppCreate, cmdAppDeploy, cmdAppRemove, cmdAppList, cmdAppRestart, cmdAppLogs, listAppSummaries } from "./app";
import type { Runtime, PackageManager } from "../lib/state";
import { cmdCertIssue, cmdCertRenew, cmdCertList, cmdCertRevoke } from "./cert";
import { getAcmeEmail } from "../lib/state";
import { cmdDbCreate, cmdDbList, cmdDbBackup } from "./db";
import { cmdRedisAllocations, cmdRedisInfo } from "./redis";
import { cmdBackupRun, cmdBackupSchedule, cmdBackupList } from "./backup";
import { cmdFirewallSync, cmdFirewallStatus } from "./firewall";
import { cmdFail2banSetup, cmdFail2banStatus } from "./fail2ban";
import { cmdTuneApply, cmdTuneShow } from "./tune";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule } from "./cloudflare";
import { cmdUpdate, cmdVersion } from "./update";
import { NAPP_VERSION } from "../version";
import { section, info, warn } from "../lib/log";

let rl: readline.Interface;

async function ask(q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

async function askYesNo(q: string, def = false): Promise<boolean> {
  const ans = await ask(`${q} [${def ? "Y/n" : "y/N"}] `);
  if (!ans) return def;
  return /^y(es)?$/i.test(ans);
}

// Cho người dùng chọn 1 giá trị từ danh sách bằng số thứ tự (hoặc gõ thẳng tên).
// Enter trống -> lấy mặc định.
async function askChoice<T extends string>(label: string, options: readonly T[], defaultValue: T): Promise<T> {
  console.log(`${label}:`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}${o === defaultValue ? "  (mặc định)" : ""}`));
  const ans = await ask(`Chọn [1-${options.length}] (Enter = ${defaultValue}): `);
  if (!ans) return defaultValue;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) {
    const picked = options[n - 1];
    if (picked !== undefined) return picked;
  }
  const byName = options.find((o) => o.toLowerCase() === ans.toLowerCase());
  if (byName) return byName;
  warn(`Lựa chọn không hợp lệ '${ans}' — dùng mặc định '${defaultValue}'.`);
  return defaultValue;
}

// Xổ danh sách app hiện có để người dùng CHỌN thay vì gõ tay domain. Trả về
// undefined nếu không có app nào, hoặc người dùng huỷ (0/Enter).
async function askAppDomain(actionLabel: string): Promise<string | undefined> {
  const apps = listAppSummaries();
  if (apps.length === 0) {
    warn("Chưa có app nào được napp quản lý — hãy tạo app trước (mục 'Tạo app mới').");
    return undefined;
  }
  console.log(`Chọn app để ${actionLabel}:`);
  apps.forEach((a, i) =>
    console.log(`  ${i + 1}. ${a.domain.padEnd(30)} port=${a.port}  ${a.running ? "● đang chạy" : "○ đã dừng"}`)
  );
  const ans = await ask(`Chọn [1-${apps.length}] (0 = huỷ): `);
  if (!ans || ans === "0") return undefined;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= apps.length) {
    const picked = apps[n - 1];
    if (picked) return picked.domain;
  }
  const byName = apps.find((a) => a.domain === ans.trim());
  if (byName) return byName.domain;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

function printMenu(title: string, items: string[]): void {
  console.clear();
  section(title);
  items.forEach((label, i) => console.log(`  ${i + 1}. ${label}`));
  console.log(`  0. Quay lại / Thoát`);
  console.log();
}

async function pause(): Promise<void> {
  await ask("\nNhấn Enter để tiếp tục...");
}

async function guard(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    warn((e as Error).message);
  }
  await pause();
}

async function menuApp(): Promise<void> {
  while (true) {
    printMenu("Quản lý App Node.js/Bun", [
      "Danh sách app",
      "Tạo app mới",
      "Deploy (git pull + rebuild + restart)",
      "Restart app",
      "Xem log (tail 100 dòng)",
      "Xoá app",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") {
      await guard(() => cmdAppList());
    } else if (choice === "2") {
      await guard(async () => {
        const domain = await ask("Domain (vd: api.example.com): ");
        const repo = await ask("Git repo URL (bỏ trống nếu chưa có): ");
        const runtime = await askChoice<Runtime>("Runtime engine", ["node", "bun"], "node");
        // Mặc định package manager theo runtime: bun -> bun, node -> npm.
        const pmDefault: PackageManager = runtime === "bun" ? "bun" : "npm";
        const packageManager = await askChoice<PackageManager>("Trình quản lý gói phụ thuộc", ["npm", "pnpm", "yarn", "bun"], pmDefault);
        const db = await askYesNo("Tạo database MariaDB riêng cho app này?");
        const redis = await askYesNo("Cấp Redis DB riêng cho app này?");
        await cmdAppCreate(domain, {
          repo: repo || undefined,
          branch: "main",
          runtime,
          packageManager,
          db,
          redis,
          env: [],
        });
      });
    } else if (choice === "3") {
      await guard(async () => {
        const domain = await askAppDomain("deploy");
        if (domain) await cmdAppDeploy(domain);
      });
    } else if (choice === "4") {
      await guard(async () => {
        const domain = await askAppDomain("restart");
        if (domain) cmdAppRestart(domain);
      });
    } else if (choice === "5") {
      await guard(async () => {
        const domain = await askAppDomain("xem log");
        if (domain) cmdAppLogs(domain, { follow: false, lines: 100 });
      });
    } else if (choice === "6") {
      await guard(async () => {
        const domain = await askAppDomain("XOÁ");
        if (!domain) return;
        const yes = await askYesNo(`Xác nhận xoá '${domain}' (không thể hoàn tác)?`);
        if (yes) await cmdAppRemove(domain, { yes: true, keepDb: false });
      });
    }
  }
}

async function menuCert(): Promise<void> {
  while (true) {
    printMenu("Quản lý SSL (Let's Encrypt / certbot)", [
      "Danh sách chứng chỉ",
      "Phát hành SSL (chọn app)",
      "Gia hạn một domain (chọn app)",
      "Gia hạn TẤT CẢ",
      "Thu hồi / gỡ chứng chỉ (chọn app)",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdCertList());
    else if (choice === "2")
      await guard(async () => {
        const domain = await askAppDomain("phát hành SSL");
        if (!domain) return;
        const saved = getAcmeEmail();
        const email = (await ask(`Email Let's Encrypt${saved ? ` (Enter = ${saved})` : " (Enter = đăng ký KHÔNG email)"}: `)).trim() || saved || "";
        cmdCertIssue(domain, { noWww: false, extra: [], email: email || undefined, registerWithoutEmail: !email, redirect: true });
      });
    else if (choice === "3")
      await guard(async () => {
        const domain = await askAppDomain("gia hạn");
        if (domain) cmdCertRenew(domain, { force: false });
      });
    else if (choice === "4") await guard(() => cmdCertRenew(undefined, { force: false }));
    else if (choice === "5")
      await guard(async () => {
        const domain = await askAppDomain("thu hồi/gỡ chứng chỉ");
        if (!domain) return;
        const yes = await askYesNo(`Thu hồi & xoá chứng chỉ của '${domain}'? Website sẽ mất HTTPS tới khi phát hành lại.`);
        if (yes) await cmdCertRevoke(domain, { yes: true });
      });
  }
}

async function menuDb(): Promise<void> {
  while (true) {
    printMenu("Quản lý Database", ["Danh sách database", "Tạo database mới", "Backup một database"]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdDbList());
    else if (choice === "2") await guard(async () => cmdDbCreate(await ask("Tên database: ")));
    else if (choice === "3") await guard(async () => cmdDbBackup(await ask("Tên database: ")));
  }
}

async function menuBackup(): Promise<void> {
  while (true) {
    printMenu("Sao lưu định kỳ", ["Chạy backup ngay (db + files)", "Lên lịch backup hàng ngày", "Danh sách bản backup"]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdBackupRun({ target: "all", keep: 7 }));
    else if (choice === "2")
      await guard(async () => {
        const time = (await ask("Giờ chạy hàng ngày (HH:MM, mặc định 03:00): ")) || "03:00";
        const keepStr = (await ask("Số bản giữ lại (mặc định 7): ")) || "7";
        cmdBackupSchedule({ time, keep: parseInt(keepStr, 10) || 7, target: "all" });
      });
    else if (choice === "3") await guard(() => cmdBackupList());
  }
}

async function menuInfra(): Promise<void> {
  while (true) {
    printMenu("Hạ tầng (Firewall / fail2ban / Cloudflare / Tối ưu)", [
      "Đồng bộ UFW (SSH + mở 80/443 công khai)",
      "Trạng thái UFW",
      "Áp cấu hình fail2ban",
      "Trạng thái fail2ban",
      "Đồng bộ Cloudflare real-IP vào nginx (chạy ngay)",
      "Lên lịch tự động đồng bộ Cloudflare (systemd timer, hàng ngày)",
      "Gỡ lịch tự động đồng bộ Cloudflare",
      "Xem đề xuất tối ưu phần cứng",
      "Áp tối ưu phần cứng (nginx/MariaDB/Redis/sysctl)",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdFirewallSync({ restrictToCloudflare: false, extraPorts: [], yes: false }));
    else if (choice === "2") await guard(() => cmdFirewallStatus());
    else if (choice === "3") await guard(() => cmdFail2banSetup({}));
    else if (choice === "4") await guard(() => cmdFail2banStatus());
    else if (choice === "5") await guard(() => cmdCloudflareSync());
    else if (choice === "6")
      await guard(async () => {
        const time = (await ask("Giờ chạy hàng ngày (HH:MM, mặc định 01:00): ")) || "01:00";
        cmdCloudflareSchedule({ time });
      });
    else if (choice === "7") await guard(() => cmdCloudflareUnschedule());
    else if (choice === "8") await guard(() => cmdTuneShow());
    else if (choice === "9") await guard(() => cmdTuneApply({ yes: false, skipRestart: false }));
  }
}

export async function runMenu(): Promise<void> {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      printMenu(`napp v${NAPP_VERSION} — Quản lý server Node.js`, [
        "Kiểm tra môi trường máy chủ",
        "Quản lý App",
        "Quản lý SSL",
        "Quản lý Database",
        "Redis",
        "Sao lưu định kỳ",
        "Hạ tầng (Firewall / fail2ban / Cloudflare / Tối ưu)",
        "Cập nhật napp",
      ]);
      const choice = await ask("Chọn: ");
      if (choice === "0" || choice === "" || choice.toLowerCase() === "q") break;
      if (choice === "1") await guard(() => cmdCheck({ fix: false, yes: false }));
      else if (choice === "2") await menuApp();
      else if (choice === "3") await menuCert();
      else if (choice === "4") await menuDb();
      else if (choice === "5") await guard(() => cmdRedisAllocations());
      else if (choice === "6") await menuBackup();
      else if (choice === "7") await menuInfra();
      else if (choice === "8") await guard(() => cmdUpdate());
    }
  } finally {
    rl.close();
  }
}

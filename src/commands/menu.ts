import readline from "node:readline/promises";
import { cmdCheck } from "./check";
import { cmdAppCreate, cmdAppDeploy, cmdAppRemove, cmdAppList, cmdAppRestart, cmdAppLogs } from "./app";
import { cmdCertIssue, cmdCertRenew, cmdCertList } from "./cert";
import { cmdDbCreate, cmdDbList, cmdDbBackup } from "./db";
import { cmdRedisAllocations, cmdRedisInfo } from "./redis";
import { cmdBackupRun, cmdBackupSchedule, cmdBackupList } from "./backup";
import { cmdFirewallSync, cmdFirewallStatus } from "./firewall";
import { cmdFail2banSetup, cmdFail2banStatus } from "./fail2ban";
import { cmdTuneApply, cmdTuneShow } from "./tune";
import { cmdCloudflareSync } from "./cloudflare";
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
        const runtime = (await ask("Runtime [node/bun] (mặc định node): ")) || "node";
        const db = await askYesNo("Tạo database MariaDB riêng cho app này?");
        const redis = await askYesNo("Cấp Redis DB riêng cho app này?");
        await cmdAppCreate(domain, {
          repo: repo || undefined,
          branch: "main",
          runtime: runtime === "bun" ? "bun" : "node",
          db,
          redis,
          env: [],
        });
      });
    } else if (choice === "3") {
      await guard(async () => cmdAppDeploy(await ask("Domain: ")));
    } else if (choice === "4") {
      await guard(async () => cmdAppRestart(await ask("Domain: ")));
    } else if (choice === "5") {
      await guard(async () => cmdAppLogs(await ask("Domain: "), { follow: false, lines: 100 }));
    } else if (choice === "6") {
      await guard(async () => {
        const domain = await ask("Domain cần xoá: ");
        const yes = await askYesNo(`Xác nhận xoá '${domain}' (không thể hoàn tác)?`);
        if (yes) await cmdAppRemove(domain, { yes: true, keepDb: false });
      });
    }
  }
}

async function menuCert(): Promise<void> {
  while (true) {
    printMenu("Quản lý SSL (certbot)", ["Danh sách chứng chỉ", "Phát hành SSL cho domain", "Gia hạn tất cả"]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdCertList());
    else if (choice === "2")
      await guard(async () => cmdCertIssue(await ask("Domain: "), { noWww: false, extra: [] }));
    else if (choice === "3") await guard(() => cmdCertRenew(undefined, { force: false }));
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
      "Đồng bộ UFW (SSH + Cloudflare-only 80/443)",
      "Trạng thái UFW",
      "Áp cấu hình fail2ban",
      "Trạng thái fail2ban",
      "Đồng bộ Cloudflare real-IP vào nginx",
      "Xem đề xuất tối ưu phần cứng",
      "Áp tối ưu phần cứng (nginx/MariaDB/Redis/sysctl)",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") await guard(() => cmdFirewallSync({ restrictToCloudflare: true, extraPorts: [], yes: false }));
    else if (choice === "2") await guard(() => cmdFirewallStatus());
    else if (choice === "3") await guard(() => cmdFail2banSetup({}));
    else if (choice === "4") await guard(() => cmdFail2banStatus());
    else if (choice === "5") await guard(() => cmdCloudflareSync());
    else if (choice === "6") await guard(() => cmdTuneShow());
    else if (choice === "7") await guard(() => cmdTuneApply({ yes: false, skipRestart: false }));
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

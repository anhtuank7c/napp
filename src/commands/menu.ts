import readline from "node:readline/promises";
import { cmdCheck } from "./check";
import { cmdDoctor, cmdDoctorSystem, cmdDoctorDeps, cmdDoctorUpgrade } from "./doctor";
import { cmdAppCreate, cmdAppDeploy, cmdAppRemove, cmdAppList, cmdAppRestart, cmdAppLogs, cmdAppSet, listAppSummaries } from "./app";
import {
  cmdServiceCreate,
  cmdServiceDeploy,
  cmdServiceRemove,
  cmdServiceList,
  cmdServiceRestart,
  cmdServiceLogs,
  listServiceSummaries,
} from "./service";
import type { Runtime, PackageManager } from "../lib/state";
import { cmdCertIssue, cmdCertRenew, cmdCertList, cmdCertRevoke } from "./cert";
import { getAcmeEmail, findUnit } from "../lib/state";
import { cmdDbCreate, cmdDbList, cmdDbBackup } from "./db";
import { cmdRedisAllocations, cmdRedisInfo } from "./redis";
import { cmdBackupRun, cmdBackupSchedule, cmdBackupList, cmdBackupUnschedule, DEFAULT_RETENTION_DAYS } from "./backup";
import { listDatabases } from "../lib/mysql";
import { cmdFirewallSync, cmdFirewallStatus } from "./firewall";
import { cmdFail2banSetup, cmdFail2banStatus } from "./fail2ban";
import { cmdTuneApply, cmdTuneShow } from "./tune";
import { cmdCloudflareSync, cmdCloudflareSchedule, cmdCloudflareUnschedule } from "./cloudflare";
import { cmdNginxHarden, cmdNginxUnharden, cmdNginxSync } from "./nginx";
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

// Nhập deploy key: CHO PHÉP dán cả khối key nhiều dòng (đọc tiếp tới dòng
// '-----END ... PRIVATE KEY-----') HOẶC nhập một đường dẫn file trên 1 dòng.
// Trả về nội dung key (dán) hoặc đường dẫn (nhập tay) — cmdAppCreate tự phân
// biệt. Bắt buộc phải đọc nhiều dòng: readline chỉ lấy 1 dòng nên nếu chỉ
// dùng ask() thì key dán vào sẽ bị cắt cụt ở dòng '-----BEGIN' đầu tiên.
async function askSshKey(): Promise<string | undefined> {
  const first = (await rl.question("Deploy key — DÁN nội dung key (bắt đầu '-----BEGIN'), hoặc nhập ĐƯỜNG DẪN file:\n")).trim();
  if (!first) return undefined;
  if (!/^-----BEGIN /.test(first)) return first; // 1 dòng, không phải header key -> coi là đường dẫn
  const lines = [first];
  // Đọc tiếp từng dòng key (không trim nội dung) tới khi gặp dòng END.
  while (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(lines[lines.length - 1]!)) {
    const line = await rl.question("");
    lines.push(line.replace(/\r$/, ""));
  }
  return lines.join("\n");
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

// Xổ danh sách background service hiện có để CHỌN thay vì gõ tay tên. Trả về
// undefined nếu không có service nào, hoặc người dùng huỷ (0/Enter).
async function askServiceName(actionLabel: string): Promise<string | undefined> {
  const services = listServiceSummaries();
  if (services.length === 0) {
    warn("Chưa có background service nào — hãy tạo service trước (mục 'Tạo service mới').");
    return undefined;
  }
  console.log(`Chọn service để ${actionLabel}:`);
  services.forEach((s, i) =>
    console.log(`  ${i + 1}. ${s.name.padEnd(30)} ${s.port !== undefined ? `port=${s.port}` : "no-port"}  ${s.running ? "● đang chạy" : "○ đã dừng"}`)
  );
  const ans = await ask(`Chọn [1-${services.length}] (0 = huỷ): `);
  if (!ans || ans === "0") return undefined;
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= services.length) {
    const picked = services[n - 1];
    if (picked) return picked.name;
  }
  const byName = services.find((s) => s.name === ans.trim());
  if (byName) return byName.name;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

// Xổ danh sách database để chọn. Trả về tên DB, "__ALL__" nếu chọn tất cả, hoặc
// undefined nếu huỷ / không có DB nào.
async function askDatabase(actionLabel: string): Promise<string | "__ALL__" | undefined> {
  const dbs = listDatabases();
  if (dbs.length === 0) {
    warn("Không tìm thấy database nào (hoặc MariaDB chưa chạy / chưa kết nối được).");
    return undefined;
  }
  console.log(`Chọn database để ${actionLabel}:`);
  dbs.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
  console.log(`  a. TẤT CẢ database`);
  const ans = (await ask(`Chọn [1-${dbs.length} / a = tất cả] (0 = huỷ): `)).trim();
  if (!ans || ans === "0") return undefined;
  if (ans.toLowerCase() === "a") return "__ALL__";
  const n = parseInt(ans, 10);
  if (Number.isInteger(n) && n >= 1 && n <= dbs.length) return dbs[n - 1];
  const byName = dbs.find((d) => d === ans);
  if (byName) return byName;
  warn(`Lựa chọn không hợp lệ: '${ans}'.`);
  return undefined;
}

// Chọn NHIỀU tuỳ chọn bằng cách bật/tắt (tick) theo số thứ tự. Mỗi tuỳ chọn có
// trạng thái mặc định (đã tick hay chưa); người dùng gõ các số để đảo trạng thái,
// Enter trống = xác nhận danh sách đang hiển thị. Trả về Set các key đang bật.
async function askMultiSelect(
  label: string,
  options: readonly { key: string; label: string; default: boolean }[]
): Promise<Set<string>> {
  const selected = new Set(options.filter((o) => o.default).map((o) => o.key));
  while (true) {
    console.log(`${label}`);
    options.forEach((o, i) => console.log(`  ${i + 1}. [${selected.has(o.key) ? "x" : " "}] ${o.label}`));
    const ans = await ask(`Gõ số để bật/tắt (cách nhau bởi dấu cách/phẩy), Enter = xác nhận: `);
    if (!ans) return selected;
    for (const tok of ans.split(/[\s,]+/).filter(Boolean)) {
      const n = parseInt(tok, 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        const key = options[n - 1]!.key;
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
      } else {
        warn(`Bỏ qua lựa chọn không hợp lệ: '${tok}'`);
      }
    }
    console.log();
  }
}

// Hỏi số ngày retention, mặc định DEFAULT_RETENTION_DAYS.
async function askRetentionDays(): Promise<number> {
  const ans = (await ask(`Giữ backup trong bao nhiêu NGÀY (retention, mặc định ${DEFAULT_RETENTION_DAYS}): `)).trim();
  const n = parseInt(ans, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
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
      "Bật nginx trả asset tĩnh (tự nhận diện framework)",
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
        // Repo PRIVATE cần xác thực trước — nếu không sẽ treo ở prompt nhập
        // username/password (HTTPS) hoặc yes/no host-key (SSH). Hỏi ngay tại đây.
        let token: string | undefined;
        let sshKey: string | undefined;
        if (repo && (await askYesNo("Repo này có PRIVATE (cần xác thực) không?"))) {
          if (/^https?:\/\//i.test(repo)) {
            token = (await ask("Personal Access Token (HTTPS): ")).trim() || undefined;
          } else {
            sshKey = await askSshKey();
          }
        }
        const runtime = await askChoice<Runtime>("Runtime engine", ["node", "bun"], "node");
        // Mặc định package manager theo runtime: bun -> bun, node -> npm.
        const pmDefault: PackageManager = runtime === "bun" ? "bun" : "npm";
        const packageManager = await askChoice<PackageManager>("Trình quản lý gói phụ thuộc", ["npm", "pnpm", "yarn", "bun"], pmDefault);
        const db = await askYesNo("Tạo database MariaDB riêng cho app này?");
        const redis = await askYesNo("Cấp Redis DB riêng cho app này?");
        // Hỏi thay vì bật ngầm: napp chiếm tiền tố URL bằng 'location ^~', thứ
        // thắng cả proxy_pass. Người dùng phải BIẾT điều đó đang xảy ra.
        const autoStatic = await askYesNo("Cho nginx trả thẳng asset tĩnh nếu nhận diện được framework (nhanh hơn nhiều)?");
        await cmdAppCreate(domain, {
          repo: repo || undefined,
          branch: "main",
          token,
          sshKey,
          runtime,
          packageManager,
          db,
          redis,
          autoStatic,
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
        const domain = await askAppDomain("bật asset tĩnh");
        if (domain) cmdAppSet(domain, { autoStatic: true });
      });
    } else if (choice === "7") {
      await guard(async () => {
        const domain = await askAppDomain("XOÁ");
        if (!domain) return;
        // Mặc định tick sẵn nginx + ssl; mã nguồn + database là tuỳ chọn (giữ dữ liệu).
        const sel = await askMultiSelect(`Chọn những gì cần xoá khi gỡ app '${domain}' ([x] = sẽ xoá; service systemd luôn bị gỡ):`, [
          { key: "nginx", label: "Cấu hình domain nginx", default: true },
          { key: "ssl", label: "Chứng chỉ SSL", default: true },
          { key: "source", label: "Mã nguồn (và user hệ thống)", default: false },
          { key: "database", label: "Database", default: false },
        ]);
        const yes = await askYesNo(`Xác nhận gỡ app '${domain}' (không thể hoàn tác)?`);
        if (yes)
          await cmdAppRemove(domain, {
            yes: true,
            nginx: sel.has("nginx"),
            ssl: sel.has("ssl"),
            source: sel.has("source"),
            database: sel.has("database"),
          });
      });
    }
  }
}

async function menuService(): Promise<void> {
  while (true) {
    printMenu("Quản lý Background Service (chạy ngầm, không domain)", [
      "Danh sách service",
      "Tạo service mới",
      "Deploy (git pull + rebuild + restart)",
      "Restart service",
      "Xem log (tail 100 dòng)",
      "Xoá service",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1") {
      await guard(() => cmdServiceList());
    } else if (choice === "2") {
      await guard(async () => {
        const name = await ask("Tên service (vd: worker-telegram, queue-email): ");
        const repo = await ask("Git repo URL (bỏ trống nếu chưa có): ");
        let token: string | undefined;
        let sshKey: string | undefined;
        if (repo && (await askYesNo("Repo này có PRIVATE (cần xác thực) không?"))) {
          if (/^https?:\/\//i.test(repo)) {
            token = (await ask("Personal Access Token (HTTPS): ")).trim() || undefined;
          } else {
            sshKey = await askSshKey();
          }
        }
        const startCmd = (await ask("Lệnh khởi động (Enter = 'npm start' theo package.json; vd: node worker.js): ")).trim() || undefined;
        const runtime = await askChoice<Runtime>("Runtime engine", ["node", "bun"], "node");
        const pmDefault: PackageManager = runtime === "bun" ? "bun" : "npm";
        const packageManager = await askChoice<PackageManager>("Trình quản lý gói phụ thuộc", ["npm", "pnpm", "yarn", "bun"], pmDefault);
        const wantPort = await askYesNo("Service có tự listen một cổng nội bộ không (health-check/socket)?");
        let port: number | undefined;
        if (wantPort) {
          const p = parseInt((await ask("Cổng nội bộ (Enter = tự cấp 3000-3999): ")).trim(), 10);
          if (Number.isInteger(p)) port = p;
        }
        // Worker "nửa kia của một app web" (nén ảnh, sinh thumbnail, dọn cache)
        // phải chạy BẰNG user của app đó mới đọc/ghi được file của nó — thư mục
        // app là 750 của user riêng, user khác không vào nổi.
        let runAs: string | undefined;
        if (await askYesNo("Worker này có đọc/ghi FILE của một app web đã có không (nén ảnh, thumbnail, dọn cache)?")) {
          runAs = await askAppDomain("chạy chung user hệ thống (worker sẽ ghi được vào thư mục của app này)");
        }
        const db = await askYesNo("Tạo database MariaDB riêng cho service này?");
        const redis = await askYesNo("Cấp Redis DB riêng cho service này?");
        // Dùng chung user gần như luôn đi kèm dùng chung hàng đợi. Chỉ hỏi khi
        // app kia thật sự có Redis DB, tránh dẫn người dùng vào lựa chọn chết.
        const sharedRedis = runAs ? findUnit(runAs)?.redisDbIndex : undefined;
        let shareRedisWith: string | undefined;
        if (redis && runAs && sharedRedis !== undefined) {
          if (await askYesNo(`Dùng CHUNG Redis DB #${sharedRedis} với '${runAs}' (BẮT BUỘC nếu worker tiêu thụ hàng đợi của app đó)?`, true)) {
            shareRedisWith = runAs;
          }
        }
        await cmdServiceCreate(name, {
          repo: repo || undefined,
          branch: "main",
          token,
          sshKey,
          startCmd,
          runtime,
          packageManager,
          port,
          db,
          redis,
          shareRedisWith,
          runAs,
          writeDirs: [],
          env: [],
        });
      });
    } else if (choice === "3") {
      await guard(async () => {
        const name = await askServiceName("deploy");
        if (name) await cmdServiceDeploy(name);
      });
    } else if (choice === "4") {
      await guard(async () => {
        const name = await askServiceName("restart");
        if (name) cmdServiceRestart(name);
      });
    } else if (choice === "5") {
      await guard(async () => {
        const name = await askServiceName("xem log");
        if (name) cmdServiceLogs(name, { follow: false, lines: 100 });
      });
    } else if (choice === "6") {
      await guard(async () => {
        const name = await askServiceName("XOÁ");
        if (!name) return;
        const sel = await askMultiSelect(`Chọn những gì cần xoá khi gỡ service '${name}' ([x] = sẽ xoá; service systemd luôn bị gỡ):`, [
          { key: "source", label: "Mã nguồn (và user hệ thống)", default: false },
          { key: "database", label: "Database", default: false },
        ]);
        const yes = await askYesNo(`Xác nhận gỡ service '${name}' (không thể hoàn tác)?`);
        if (yes)
          await cmdServiceRemove(name, {
            yes: true,
            source: sel.has("source"),
            database: sel.has("database"),
          });
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
        await cmdCertIssue(domain, { noWww: false, extra: [], email: email || undefined, registerWithoutEmail: !email, redirect: true });
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
    printMenu("Sao lưu (nén gzip)", [
      "Backup DATABASE ngay (chọn database)",
      "Backup mã nguồn (files) ngay",
      "Backup TẤT CẢ ngay (database + files)",
      "Lên lịch tự động backup hàng ngày",
      "Gỡ lịch backup tự động",
      "Danh sách các bản backup",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1")
      await guard(async () => {
        const db = await askDatabase("backup");
        if (!db) return;
        const keepDays = await askRetentionDays();
        cmdBackupRun({ target: "db", database: db === "__ALL__" ? undefined : db, keepDays });
      });
    else if (choice === "2")
      await guard(async () => {
        const keepDays = await askRetentionDays();
        cmdBackupRun({ target: "files", keepDays });
      });
    else if (choice === "3")
      await guard(async () => {
        const keepDays = await askRetentionDays();
        cmdBackupRun({ target: "all", keepDays });
      });
    else if (choice === "4")
      await guard(async () => {
        const time = (await ask("Giờ chạy hàng ngày (HH:MM, mặc định 03:00): ")).trim() || "03:00";
        const keepDays = await askRetentionDays();
        cmdBackupSchedule({ time, keepDays, target: "all" });
      });
    else if (choice === "5") await guard(() => cmdBackupUnschedule());
    else if (choice === "6") await guard(() => cmdBackupList());
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
      "Bảo vệ nginx: chặn truy cập IP/Host lạ (harden)",
      "Gỡ bảo vệ nginx (unharden)",
      "Đồng bộ cấu hình proxy nginx vào vhost đã có (bộ đệm — sửa 502 route sâu)",
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
    else if (choice === "8") await guard(() => cmdNginxHarden());
    else if (choice === "9") await guard(() => cmdNginxUnharden());
    else if (choice === "10") await guard(() => cmdNginxSync());
    else if (choice === "11") await guard(() => cmdTuneShow());
    else if (choice === "12") await guard(() => cmdTuneApply({ yes: false, skipRestart: false, syncUnits: false }));
  }
}

async function menuDoctor(): Promise<void> {
  while (true) {
    printMenu("Bảo mật (doctor)", [
      "Quét TẤT CẢ (bản vá hệ thống + dependencies)",
      "Kiểm tra bản vá bảo mật của hệ thống",
      "Quét dependencies của MỌI app/service",
      "Quét dependencies của MỘT app (chọn)",
      "Quét dependencies của MỘT service (chọn)",
      "Cài bản vá BẢO MẬT ngay (apt + restart dịch vụ)",
      "Cài TẤT CẢ bản cập nhật đang chờ",
    ]);
    const choice = await ask("Chọn: ");
    if (choice === "0" || choice === "") return;
    if (choice === "1")
      await guard(async () => {
        const deep = await askYesNo("Tra thêm tuổi bản phát hành trên registry npm (cần mạng, chậm hơn)?", false);
        await cmdDoctor({ refresh: true, audit: true, deep });
      });
    else if (choice === "2") await guard(async () => void cmdDoctorSystem({ refresh: true }));
    else if (choice === "3") await guard(async () => void (await cmdDoctorDeps({ audit: true, deep: false })));
    else if (choice === "4")
      await guard(async () => {
        const domain = await askAppDomain("quét dependencies");
        if (domain) await cmdDoctorDeps({ target: domain, audit: true, deep: false });
      });
    else if (choice === "5")
      await guard(async () => {
        const name = await askServiceName("quét dependencies");
        if (name) await cmdDoctorDeps({ target: name, audit: true, deep: false });
      });
    else if (choice === "6") await guard(() => cmdDoctorUpgrade({ all: false, only: [], yes: false, restart: true }));
    else if (choice === "7") await guard(() => cmdDoctorUpgrade({ all: true, only: [], yes: false, restart: true }));
  }
}

export async function runMenu(): Promise<void> {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      printMenu(`napp v${NAPP_VERSION} — Quản lý server Node.js`, [
        "Kiểm tra môi trường máy chủ",
        "Quản lý App (web, có domain)",
        "Quản lý Background Service (chạy ngầm)",
        "Quản lý SSL",
        "Quản lý Database",
        "Redis",
        "Sao lưu định kỳ",
        "Hạ tầng (Firewall / fail2ban / Cloudflare / Tối ưu)",
        "Bảo mật: bản vá hệ thống & rủi ro dependencies (doctor)",
        "Cập nhật napp",
      ]);
      const choice = await ask("Chọn: ");
      if (choice === "0" || choice === "" || choice.toLowerCase() === "q") break;
      if (choice === "1") await guard(() => cmdCheck({ fix: false, yes: false }));
      else if (choice === "2") await menuApp();
      else if (choice === "3") await menuService();
      else if (choice === "4") await menuCert();
      else if (choice === "5") await menuDb();
      else if (choice === "6") await guard(() => cmdRedisAllocations());
      else if (choice === "7") await menuBackup();
      else if (choice === "8") await menuInfra();
      else if (choice === "9") await menuDoctor();
      else if (choice === "10") await guard(() => cmdUpdate());
    }
  } finally {
    rl.close();
  }
}

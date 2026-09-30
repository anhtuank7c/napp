import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execCapture, runCmd, commandExists, writeFile, ensureDir, state as execState } from "../exec";
import { die, dryRunNotice, ok, info, warn } from "../log";
import type { HardwareProfile } from "../hardware";
import type { CreatedDb, DbDriver } from "./types";
import { aptGet } from "../apt";
import { randomPassword, dpkgInstalled, anyUnitActive, processRunning, aptRemove, connectionUrl, preflightInstall } from "./common";

// MongoDB KHÁC hẳn ba engine còn lại ở bốn điểm, và mỗi điểm là một cái bẫy:
//
// 1. KHÔNG có trong kho Ubuntu (giấy phép SSPL) -> phải thêm kho apt chính thức
//    của MongoDB kèm khoá GPG, và kho đó chỉ hỗ trợ vài bản phát hành cụ thể.
// 2. MongoDB >= 5.0 cần CPU có AVX. Nhiều VPS giá rẻ / CPU ảo hoá cũ KHÔNG có:
//    mongod cài xong rồi chết ngay bằng "Illegal instruction" — phải chặn TRƯỚC.
// 3. Xác thực TẮT theo mặc định. Ai chạm tới cổng 27017 là toàn quyền mọi
//    database. napp bật authorization ngay khi cài và giữ tài khoản quản trị
//    trong /etc/napp (0600, chỉ root).
// 4. mongod.conf là YAML và KHÔNG có thư mục include kiểu conf.d -> napp chỉ sửa
//    đúng vài khoá nó cần, giữ nguyên mọi thứ người dùng tự sửa.

const MONGO_SERIES = "8.0";
const MONGOD_CONF = "/etc/mongod.conf";
const ADMIN_CREDS_PATH = "/etc/napp/mongo-admin.json";
// File cấu hình cho mongodump: giữ mật khẩu NGOÀI argv (ai cũng đọc được qua 'ps').
const TOOLS_CONF_PATH = "/etc/napp/mongo-tools.yaml";
const KEYRING = `/usr/share/keyrings/mongodb-server-${MONGO_SERIES}.gpg`;
const SOURCES_LIST = `/etc/apt/sources.list.d/mongodb-org-${MONGO_SERIES}.list`;
const ADMIN_USER = "napp_admin";
const SYSTEM_DBS = new Set(["admin", "local", "config"]);

interface AdminCreds {
  user: string;
  password: string;
}

function readCreds(): AdminCreds | undefined {
  if (!existsSync(ADMIN_CREDS_PATH)) return undefined;
  try {
    const c = JSON.parse(readFileSync(ADMIN_CREDS_PATH, "utf8")) as AdminCreds;
    return c.user && c.password ? c : undefined;
  } catch {
    return undefined;
  }
}

function osCodename(): { id: string; codename: string } {
  const out = { id: "", codename: "" };
  if (!existsSync("/etc/os-release")) return out;
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const m = line.match(/^(ID|VERSION_CODENAME)=(.*)$/);
    if (!m) continue;
    const v = m[2]!.replace(/^"|"$/g, "");
    if (m[1] === "ID") out.id = v;
    else out.codename = v;
  }
  return out;
}

// Kho mongodb-org 8.0 chỉ phát hành cho các bản dưới đây.
function repoLine(): string {
  const { id, codename } = osCodename();
  const arch = execCapture("dpkg", ["--print-architecture"]).stdout.trim();
  if (arch !== "amd64" && arch !== "arm64") die(`MongoDB chỉ hỗ trợ amd64/arm64 (máy này: ${arch || "không rõ"}).`);
  if (id === "ubuntu" && ["jammy", "noble"].includes(codename)) {
    return `deb [ arch=${arch} signed-by=${KEYRING} ] https://repo.mongodb.org/apt/ubuntu ${codename}/mongodb-org/${MONGO_SERIES} multiverse`;
  }
  if (id === "debian" && codename === "bookworm") {
    return `deb [ arch=${arch} signed-by=${KEYRING} ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/${MONGO_SERIES} main`;
  }
  die(
    `Kho MongoDB ${MONGO_SERIES} chưa hỗ trợ hệ điều hành này (${id || "?"} ${codename || "?"}). ` +
      "Hỗ trợ: Ubuntu 22.04 (jammy), 24.04 (noble), Debian 12 (bookworm)."
  );
}

function requireAvx(): void {
  const arch = process.arch;
  if (arch !== "x64") return; // arm64: yêu cầu ARMv8.2-A, không có cờ đơn giản để dò
  let flags = "";
  try {
    flags = readFileSync("/proc/cpuinfo", "utf8").match(/^flags\s*:\s*(.*)$/m)?.[1] ?? "";
  } catch {
    return; // không đọc được thì để apt/mongod tự báo
  }
  if (!/\bavx\b/.test(flags)) {
    die(
      "CPU của máy này KHÔNG có AVX — MongoDB >= 5.0 sẽ chết ngay khi khởi động ('Illegal instruction').\n" +
        "  Thường gặp ở VPS giá rẻ dùng CPU ảo hoá kiểu 'kvm64/qemu64'. Hãy xin nhà cung cấp bật 'host CPU passthrough',\n" +
        "  đổi gói VPS, hoặc dùng MongoDB Atlas / PostgreSQL (JSONB) thay thế."
    );
  }
}

// Chạy một đoạn JS bằng mongosh. Script (chứa mật khẩu) nằm trong file tạm 0600
// trong thư mục 0700 và bị xoá ngay sau đó — không bao giờ nằm trong argv.
function mongoEval(js: string, creds?: AdminCreds): { ok: boolean; out: string; err: string } {
  const dir = mkdtempSync(`${tmpdir()}/napp-mongo-`);
  const file = `${dir}/script.js`;
  const uri = creds
    ? `mongodb://${creds.user}:${creds.password}@127.0.0.1:27017/admin?authSource=admin`
    : "mongodb://127.0.0.1:27017/admin";
  try {
    writeFileSync(file, `const conn = connect(${JSON.stringify(uri)});\n${js}\n`, { mode: 0o600 });
    const res = execCapture("mongosh", ["--quiet", "--norc", "--nodb", "--file", file]);
    return { ok: res.code === 0, out: res.stdout.trim(), err: res.stderr.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function adminEval(js: string): { ok: boolean; out: string; err: string } {
  return mongoEval(js, readCreds());
}

function waitForMongod(seconds: number): boolean {
  for (let i = 0; i < seconds; i++) {
    if (mongoEval(`print(conn.getSiblingDB("admin").runCommand({ ping: 1 }).ok)`).out.endsWith("1")) return true;
    execCapture("sleep", ["1"]);
  }
  return false;
}

// --- Sửa mongod.conf: chỉ đúng khoá cần sửa --------------------------------

/** Vị trí [start, end) của khối YAML cấp cao nhất `key:` (bỏ qua dòng comment). */
function topBlock(lines: string[], key: string): [number, number] | undefined {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!) || lines[end]!.startsWith("#"))) end++;
  return [start, end];
}

export function enableMongoAuth(conf: string): string {
  const lines = conf.split("\n");
  const block = topBlock(lines, "security");
  if (!block) return conf.replace(/\n*$/, "\n") + "\nsecurity:\n  authorization: enabled\n";
  const [s, e] = block;
  const idx = lines.slice(s + 1, e).findIndex((l) => /^\s+authorization:/.test(l));
  if (idx >= 0) lines[s + 1 + idx] = lines[s + 1 + idx]!.replace(/authorization:.*/, "authorization: enabled");
  else lines.splice(s + 1, 0, "  authorization: enabled");
  return lines.join("\n");
}

/** Trả về undefined nếu cấu trúc khối storage lạ (người dùng tự sửa) — khi đó KHÔNG đụng vào. */
export function setMongoCacheSize(conf: string, gb: number): string | undefined {
  const lines = conf.split("\n");
  const existing = lines.findIndex((l) => /^\s+cacheSizeGB:/.test(l));
  if (existing >= 0) {
    lines[existing] = lines[existing]!.replace(/cacheSizeGB:.*/, `cacheSizeGB: ${gb}`);
    return lines.join("\n");
  }
  const block = topBlock(lines, "storage");
  if (!block) return conf.replace(/\n*$/, "\n") + `\nstorage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: ${gb}\n`;
  const [s, e] = block;
  if (lines.slice(s + 1, e).some((l) => /^\s+wiredTiger:/.test(l))) return undefined;
  lines.splice(s + 1, 0, "  wiredTiger:", "    engineConfig:", `      cacheSizeGB: ${gb}`);
  return lines.join("\n");
}

function bindIpIsLoopback(conf: string): boolean {
  const m = conf.match(/^\s+bindIp:\s*(.+)$/m);
  if (!m) return true; // mặc định của mongod là localhost
  return m[1]!.split(",").every((ip) => ["127.0.0.1", "localhost", "::1"].includes(ip.trim()));
}

function cacheSizeGB(budgetMB: number): number {
  // WiredTiger cache ~ một nửa ngân sách; phần còn lại cho page cache của OS
  // (mongod dựa vào nó cho dữ liệu nén) và bộ nhớ kết nối. Mặc định của mongod
  // (50% RAM TOÀN MÁY − 1GB) sẽ bóp chết các app Node trên cùng server.
  return Math.max(0.25, Math.round((budgetMB * 0.5) / 1024 * 100) / 100);
}

// Tạo tài khoản quản trị qua "localhost exception" (chỉ hoạt động khi chưa có
// user nào), lưu lại, rồi bật authorization.
function bootstrapAuth(): void {
  const existing = readCreds();
  if (existing && mongoEval(`print(conn.getSiblingDB("admin").runCommand({ connectionStatus: 1 }).ok)`, existing).out.endsWith("1")) {
    info("MongoDB: tài khoản quản trị của napp đã có và dùng được.");
  } else {
    const creds: AdminCreds = { user: ADMIN_USER, password: randomPassword() };
    const res = mongoEval(
      `conn.getSiblingDB("admin").createUser({ user: ${JSON.stringify(creds.user)}, pwd: ${JSON.stringify(creds.password)}, roles: [{ role: "root", db: "admin" }] }); print("ok");`
    );
    if (!res.ok) {
      die(
        `Không tạo được tài khoản quản trị MongoDB: ${res.err || res.out}\n` +
          "  Nếu MongoDB đã có user từ trước (authorization bật sẵn), hãy tự tạo user role 'root' rồi ghi vào\n" +
          `  ${ADMIN_CREDS_PATH} dạng {"user":"...","password":"..."} (chmod 600).`
      );
    }
    ensureDir("/etc/napp", 0o750);
    writeFile(ADMIN_CREDS_PATH, JSON.stringify(creds, null, 2) + "\n", 0o600);
    writeFile(TOOLS_CONF_PATH, `password: ${creds.password}\n`, 0o600);
    ok(`MongoDB: đã tạo tài khoản quản trị '${creds.user}' (lưu ở ${ADMIN_CREDS_PATH}, chỉ root đọc được).`);
  }
  if (existsSync(MONGOD_CONF)) {
    const conf = readFileSync(MONGOD_CONF, "utf8");
    const next = enableMongoAuth(conf);
    if (next !== conf) {
      writeFile(MONGOD_CONF, next, 0o644);
      runCmd("systemctl", ["restart", "mongod"]);
      waitForMongod(30);
    }
    if (!bindIpIsLoopback(next)) warn(`${MONGOD_CONF}: bindIp KHÔNG chỉ là 127.0.0.1 — MongoDB đang lắng nghe ra ngoài. Hãy chắc chắn firewall chặn cổng 27017.`);
  }
  ok("MongoDB: đã bật xác thực (security.authorization: enabled).");
}

export const mongoDriver: DbDriver = {
  engine: "mongodb",
  label: "MongoDB",
  port: 27017,
  systemdUnits: ["mongod"],
  dumpExt: ".archive.gz",
  maxNameLength: 63,

  isInstalled() {
    return dpkgInstalled("mongodb-org-server") || dpkgInstalled("mongodb-org") || commandExists("mongod");
  },

  isRunning() {
    return anyUnitActive(["mongod"]) || processRunning(["mongod"]);
  },

  unit() {
    return "mongod";
  },

  install() {
    requireAvx();
    const line = repoLine();
    preflightInstall("MongoDB", 27017, "/var/lib/mongodb", 2048);
    info(`Đang thêm kho apt chính thức của MongoDB ${MONGO_SERIES}...`);
    aptGet(["update"]);
    aptGet(["install", "-y", "gnupg", "curl"]);
    runCmd("bash", [
      "-lc",
      `set -o pipefail; curl -fsSL https://www.mongodb.org/static/pgp/server-${MONGO_SERIES}.asc | gpg --dearmor --yes -o ${KEYRING}`,
    ]);
    writeFile(SOURCES_LIST, line + "\n", 0o644);
    info("Đang cài đặt MongoDB server (mongodb-org)...");
    aptGet(["update"]);
    aptGet(["install", "-y", "mongodb-org"]);
    runCmd("systemctl", ["enable", "--now", "mongod"]);
    if (execState.dryRun) {
      dryRunNotice("Sẽ tạo tài khoản quản trị MongoDB và bật security.authorization");
      return;
    }
    if (!waitForMongod(30)) die("mongod không phản hồi sau 30 giây — xem: journalctl -u mongod -n 50");
    bootstrapAuth();
    ok(`Đã cài MongoDB ${MONGO_SERIES}.`);
  },

  // MongoDB cài tay thường để NGUYÊN xác thực tắt. Nhận quản lý mà không bật
  // lên là để lại một database ai chạm tới cổng 27017 cũng toàn quyền.
  adopt() {
    if (readCreds() && this.canConnectAsAdmin()) return;
    if (execState.dryRun) {
      dryRunNotice("Sẽ tạo tài khoản quản trị MongoDB và bật security.authorization");
      return;
    }
    if (!waitForMongod(30)) die("mongod không phản hồi — khởi động nó trước: systemctl start mongod");
    bootstrapAuth();
  },

  uninstall({ purge }) {
    runCmd("systemctl", ["disable", "--now", "mongod"], { silentFail: true });
    aptRemove(
      ["mongodb-org", "mongodb-org-server", "mongodb-org-mongos", "mongodb-org-tools", "mongodb-org-database", "mongodb-org-shell", "mongodb-mongosh", "mongodb-database-tools"],
      purge
    );
    if (purge) {
      runCmd("rm", ["-rf", "/var/lib/mongodb", "/var/log/mongodb", ADMIN_CREDS_PATH, TOOLS_CONF_PATH, SOURCES_LIST, KEYRING], { silentFail: true });
    }
  },

  canConnectAsAdmin() {
    if (!commandExists("mongosh") || !readCreds()) return false;
    return adminEval(`print(conn.getSiblingDB("admin").runCommand({ connectionStatus: 1 }).ok)`).out.endsWith("1");
  },

  // Database MongoDB chỉ "tồn tại" khi đã có dữ liệu. Database napp vừa tạo cho
  // app mới chỉ có user (lưu ở admin.system.users) — gộp cả hai nguồn để nó
  // vẫn hiện trong danh sách và không bị tạo trùng.
  list() {
    if (!commandExists("mongosh") || !readCreds()) return [];
    const res = adminEval(
      `const a = conn.getSiblingDB("admin");
const names = new Set(a.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name));
a.getCollection("system.users").distinct("db").forEach((d) => names.add(d));
print(JSON.stringify([...names]));`
    );
    if (!res.ok) return [];
    try {
      return (JSON.parse(res.out.split("\n").pop() ?? "[]") as string[]).filter((d) => !SYSTEM_DBS.has(d)).sort();
    } catch {
      return [];
    }
  },

  exists(name) {
    return this.list().includes(name);
  },

  // User riêng tạo NGAY TRONG database của app (authSource=<db>), chỉ có
  // readWrite trên đúng database đó.
  create(name, user): CreatedDb {
    if (!execState.dryRun) {
      if (!this.canConnectAsAdmin()) {
        if (!this.isRunning()) die("MongoDB chưa chạy — không thể tạo database. Hãy 'systemctl start mongod' hoặc bỏ tuỳ chọn --db.");
        die(
          `Không kết nối được MongoDB bằng tài khoản quản trị của napp (${ADMIN_CREDS_PATH}).\n` +
            "  MongoDB cài KHÔNG qua napp: tạo user role 'root' rồi ghi {\"user\",\"password\"} vào file trên (chmod 600)."
        );
      }
      if (this.exists(name)) die(`Database '${name}' đã tồn tại — không ghi đè. Hãy tự xử lý hoặc bỏ tuỳ chọn --db.`);
    }
    const password = randomPassword();
    if (execState.dryRun) {
      dryRunNotice(`Sẽ tạo database MongoDB '${name}' + user '${user}' (readWrite, mật khẩu ngẫu nhiên)`);
      return { name, user, password: "<dry-run>" };
    }
    const res = adminEval(
      `conn.getSiblingDB(${JSON.stringify(name)}).createUser({ user: ${JSON.stringify(user)}, pwd: ${JSON.stringify(password)}, roles: [{ role: "readWrite", db: ${JSON.stringify(name)} }] }); print("ok");`
    );
    if (!res.ok) die(`Không tạo được user MongoDB '${user}': ${res.err || res.out}`);
    return { name, user, password };
  },

  drop(name, user) {
    if (execState.dryRun) {
      dryRunNotice(`Sẽ xoá database MongoDB '${name}'${user ? ` + user '${user}'` : ""}`);
      return;
    }
    const res = adminEval(
      `const d = conn.getSiblingDB(${JSON.stringify(name)});
${user ? `if (d.getUser(${JSON.stringify(user)})) d.dropUser(${JSON.stringify(user)});` : ""}
d.dropDatabase(); print("ok");`
    );
    if (!res.ok) die(`Không xoá được database MongoDB '${name}': ${res.err || res.out}`);
  },

  dump(name, outPath) {
    runCmd("mongodump", [
      "--host=127.0.0.1",
      "--port=27017",
      `--username=${readCreds()?.user ?? ADMIN_USER}`,
      "--authenticationDatabase=admin",
      `--config=${TOOLS_CONF_PATH}`,
      `--db=${name}`,
      `--archive=${outPath}`,
      "--gzip",
      "--quiet",
    ]);
  },

  dumpAll(outPath) {
    runCmd("mongodump", [
      "--host=127.0.0.1",
      "--port=27017",
      `--username=${readCreds()?.user ?? ADMIN_USER}`,
      "--authenticationDatabase=admin",
      `--config=${TOOLS_CONF_PATH}`,
      `--archive=${outPath}`,
      "--gzip",
      "--quiet",
    ]);
  },

  envFor(db) {
    const url = connectionUrl("mongodb", db, 27017, `?authSource=${db.name}`);
    return {
      DB_CONNECTION: "mongodb",
      DB_HOST: "127.0.0.1",
      DB_PORT: "27017",
      DB_DATABASE: db.name,
      DB_USERNAME: db.user,
      DB_PASSWORD: db.password,
      DATABASE_URL: url,
      MONGODB_URI: url,
    };
  },

  describeTuning(_hw, budgetMB) {
    return [`WiredTiger cacheSizeGB ${cacheSizeGB(budgetMB)}`];
  },

  applyTuning(_hw, budgetMB, opts) {
    if (!existsSync(MONGOD_CONF)) {
      info(`Không tìm thấy ${MONGOD_CONF} — bỏ qua tuning MongoDB.`);
      return;
    }
    const gb = cacheSizeGB(budgetMB);
    const conf = readFileSync(MONGOD_CONF, "utf8");
    const next = setMongoCacheSize(conf, gb);
    if (next === undefined) {
      warn(
        `${MONGOD_CONF}: khối storage.wiredTiger đã được sửa tay theo cấu trúc napp không nhận ra — KHÔNG đụng vào.\n` +
          `  Hãy tự đặt storage.wiredTiger.engineConfig.cacheSizeGB: ${gb}`
      );
      return;
    }
    if (next === conf) {
      ok(`MongoDB cacheSizeGB đã là ${gb} — không cần đổi.`);
      return;
    }
    writeFile(MONGOD_CONF, next, 0o644);
    if (!opts.skipRestart && this.isRunning()) {
      runCmd("systemctl", ["restart", "mongod"]);
      ok(`Đã đặt MongoDB cacheSizeGB = ${gb} và khởi động lại.`);
    } else {
      ok(`Đã ghi cacheSizeGB = ${gb} vào ${MONGOD_CONF}${opts.skipRestart ? " — chưa restart do --skip-restart." : " — service chưa chạy nên chưa restart."}`);
    }
  },
};

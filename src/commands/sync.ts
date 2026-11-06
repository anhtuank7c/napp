import { requireRoot } from "../lib/exec";
import { info, ok, warn, section, printDie, colorText } from "../lib/log";
import { confirm } from "../lib/prompt";
import { loadState } from "../lib/state";
import { acquireLock } from "../lib/lock";
import { fetchRemote, planDeploy, printPlan, type DeployPlan, type DeployTarget } from "../lib/deploy";
import { appDeployTarget, cmdAppDeploy } from "./app";
import { serviceDeployTarget, cmdServiceDeploy } from "./service";

export interface SyncOptions {
  check?: boolean; // chỉ báo đơn vị nào có bản mới
  yes?: boolean; // không hỏi xác nhận
  restart?: boolean; // false = --no-restart
}

interface Unit {
  target: DeployTarget;
  deploy: () => Promise<void>;
}

/**
 * `napp sync`: kiểm tra MỌI app/service có liên kết repo, rồi deploy những đơn
 * vị có commit mới — mỗi đơn vị chỉ cài/build/restart phần cần thiết (xem
 * lib/deploy.ts). Đơn vị đã ở bản mới nhất thì không bị đụng tới. Một đơn vị
 * hỏng không chặn các đơn vị còn lại.
 */
export async function cmdSync(o: SyncOptions): Promise<void> {
  requireRoot();
  const s = loadState();
  const deployOpts = { restart: o.restart };
  const units: Unit[] = [
    ...Object.values(s.apps)
      .filter((a) => a.repoUrl)
      .map((a) => ({ target: appDeployTarget(a), deploy: () => cmdAppDeploy(a.domain, deployOpts) })),
    ...Object.values(s.services)
      .filter((v) => v.repoUrl)
      .map((v) => ({ target: serviceDeployTarget(v), deploy: () => cmdServiceDeploy(v.name, deployOpts) })),
  ];
  if (units.length === 0) {
    info("Không có app/service nào liên kết repo git (--repo) — không có gì để đồng bộ.");
    return;
  }

  section(`Kiểm tra bản mới trên git (${units.length} đơn vị)`);
  const pending: Unit[] = [];
  const failed: string[] = [];
  for (const u of units) {
    let plan: DeployPlan;
    const release = acquireLock(u.target.id);
    try {
      plan = planDeploy(u.target, fetchRemote(u.target), {});
    } catch (e) {
      failed.push(u.target.id);
      printDie(`${u.target.id}: ${(e as Error).message}`);
      continue;
    } finally {
      release();
    }
    printPlan(u.target, plan);
    if (!plan.upToDate) pending.push(u);
  }

  console.log();
  if (pending.length === 0) {
    ok(failed.length ? `Không có bản mới (${failed.length} đơn vị kiểm tra lỗi: ${failed.join(", ")}).` : "Mọi đơn vị đều đã ở bản mới nhất.");
    return;
  }
  info(`${pending.length} đơn vị có bản mới: ${pending.map((u) => u.target.id).join(", ")}`);
  if (o.check) {
    info("Chỉ kiểm tra (--check). Deploy tất cả: napp sync · từng cái: napp app|service deploy <id>");
    return;
  }
  if (!o.yes) {
    if (!process.stdin.isTTY) {
      warn("Không có terminal để xác nhận — thêm --yes để deploy.");
      return;
    }
    if (!(await confirm(`Deploy ${pending.length} đơn vị này?`, true))) return;
  }

  const done: string[] = [];
  for (const u of pending) {
    try {
      await u.deploy();
      done.push(u.target.id);
    } catch (e) {
      failed.push(u.target.id);
      printDie(`${u.target.id}: ${(e as Error).message}`);
    }
  }
  section("Kết quả đồng bộ");
  if (done.length) ok(`Đã deploy: ${done.join(", ")}`);
  if (failed.length) warn(`Lỗi: ${failed.join(", ")} — ${colorText("dim", "các đơn vị này vẫn chạy bản cũ; xem lỗi ở trên rồi chạy lại 'napp app|service deploy <id>'")}`);
  if (failed.length) process.exitCode = 1;
}

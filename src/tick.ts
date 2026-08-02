// `etium tick`: reconcile every run to where it should be (§6.1). Idempotent;
// safe from cron; the whole liveness story for daemonless operation.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadState, writeStateCache } from "./ledger.ts";
import { isLockLive, readLock } from "./lock.ts";
import { decisionsDir } from "./lock.ts";
import { supervise, superviseDetached } from "./supervisor.ts";

const TICK_LOCK_STALE_MS = 5 * 60_000;

export interface TickAction {
  run: string;
  action: "skip-completed" | "skip-running" | "skip-parked" | "resume";
  detail?: string;
}

function acquireTickLock(base: string): boolean {
  const p = path.join(base, ".tick.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(p).mtimeMs < TICK_LOCK_STALE_MS) return false;
        fs.unlinkSync(p);
      } catch {
        return false;
      }
    }
  }
  return false;
}

export async function tickOnce(base: string, entry: string, sync: boolean): Promise<TickAction[]> {
  const runsDir = path.join(base, "runs");
  if (!fs.existsSync(runsDir)) return [];
  if (!acquireTickLock(base)) return [{ run: "-", action: "skip-running", detail: "another tick holds the lock" }];
  const actions: TickAction[] = [];
  try {
    for (const name of fs.readdirSync(runsDir).sort()) {
      const runDir = path.join(runsDir, name);
      if (!fs.statSync(runDir).isDirectory()) continue;
      const st = loadState(runDir);
      if (st.completed) {
        writeStateCache(runDir, st);
        actions.push({ run: name, action: "skip-completed" });
        continue;
      }
      if (isLockLive(runDir, readLock(runDir))) {
        actions.push({ run: name, action: "skip-running" });
        continue;
      }
      if (st.status === "parked") {
        const dd = decisionsDir(runDir);
        const pending = fs.existsSync(dd) && fs.readdirSync(dd).length > 0;
        if (!pending) {
          actions.push({ run: name, action: "skip-parked", detail: "no pending decisions" });
          continue;
        }
      }
      // created (spawn never happened), interrupted, orphaned-running, or
      // parked-with-decisions: attach a supervisor. It reconciles the rest.
      actions.push({ run: name, action: "resume", detail: st.status });
      if (sync) await supervise(runDir);
      else superviseDetached(runDir, entry);
    }
  } finally {
    try {
      fs.unlinkSync(path.join(base, ".tick.lock"));
    } catch {
      /* already gone */
    }
  }
  return actions;
}

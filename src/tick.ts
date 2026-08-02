// `etium tick`: reconcile every run to where it should be (§6.1), and drive
// pull-based surfaces (§10.3) — poll external systems into tasks and gate
// decisions, project run state back out. Idempotent; safe from cron; the
// whole liveness story for daemonless operation.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadState, writeStateCache } from "./ledger.ts";
import { isLockLive, readLock, writeDecision } from "./lock.ts";
import { decisionsDir } from "./lock.ts";
import { createRun, supervise, superviseDetached } from "./supervisor.ts";
import type { RunView, Surface, SurfacePollResult } from "./types.ts";

const TICK_LOCK_STALE_MS = 5 * 60_000;

export interface TickAction {
  run: string;
  action:
    | "skip-completed"
    | "skip-running"
    | "skip-parked"
    | "resume"
    | "surface-task"
    | "surface-decision"
    | "surface-drop"
    | "surface-skip"
    | "surface-error";
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

/** Load surface modules by path (dynamic import; `.ts` allowed like loops). */
export async function loadSurfaces(paths: string[]): Promise<Surface[]> {
  const out: Surface[] = [];
  for (const p of paths) {
    const mod = (await import(pathToFileURL(path.resolve(p)).href)) as { default?: Surface };
    const s = mod.default;
    if (!s || typeof s.id !== "string" || typeof s.poll !== "function")
      throw new Error(`surface module must default-export { id, poll, project? }: ${p}`);
    out.push(s);
  }
  return out;
}

/** Derived, read-only views of every run — what surfaces poll and project against. */
function runViews(runsDir: string): RunView[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: RunView[] = [];
  for (const name of fs.readdirSync(runsDir).sort()) {
    const dir = path.join(runsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    try {
      const st = loadState(dir);
      out.push({
        id: name,
        dir,
        status: st.status,
        params: st.created?.params ?? {},
        workspace: st.created?.workspace ?? "",
        openGates: [...st.gates.values()].filter((g) => g.opened && !g.decided).map((g) => g.opened!),
        usage: st.usage,
        seq: st.seq,
        lastEventTs: st.lastEventTs,
        completed: st.completed,
      });
    } catch {
      /* unreadable run dir: skip from views; reconcile will surface it */
    }
  }
  return out;
}

const cursorPath = (base: string, id: string) => path.join(base, "surfaces", `${id}.cursor`);
function readCursor(base: string, id: string): string | null {
  try {
    return fs.readFileSync(cursorPath(base, id), "utf8");
  } catch {
    return null;
  }
}
function writeCursor(base: string, id: string, cursor: string): void {
  fs.mkdirSync(path.join(base, "surfaces"), { recursive: true });
  fs.writeFileSync(cursorPath(base, id), cursor);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Poll one surface: create runs for new tasks (idempotent by task key) and
 * write valid decisions into mailboxes. Cursor advances only after the
 * poll's actions have durably landed; redelivery is handled by the key check
 * and by decisions failing closed. */
async function driveSurface(base: string, runsDir: string, s: Surface, actions: TickAction[]): Promise<void> {
  const views = runViews(runsDir);
  let res: SurfacePollResult;
  try {
    res = await s.poll({ cursor: readCursor(base, s.id), runs: views });
  } catch (e) {
    actions.push({ run: "-", action: "surface-error", detail: `${s.id} poll: ${errMsg(e)}` });
    return;
  }

  const known = new Set(views.map((v) => v.params["surface.task"]).filter(Boolean));
  for (const t of res.tasks ?? []) {
    const tag = `${s.id}:${t.key}`;
    if (!t.key) {
      actions.push({ run: "-", action: "surface-error", detail: `${s.id} task without key` });
      continue;
    }
    if (known.has(tag)) {
      actions.push({ run: "-", action: "surface-skip", detail: `task ${tag} already has a run` });
      continue;
    }
    known.add(tag);
    try {
      const { runId } = createRun(base, {
        task: t.task,
        loop: t.loop,
        params: { ...t.params, surface: s.id, "surface.task": tag },
        workspace: t.workspace,
        preapprove: t.preapprove,
        maxSteps: t.maxSteps,
      });
      actions.push({ run: runId, action: "surface-task", detail: tag });
    } catch (e) {
      actions.push({ run: "-", action: "surface-error", detail: `${s.id} task ${tag}: ${errMsg(e)}` });
    }
  }

  for (const d of res.decisions ?? []) {
    const view = views.find((v) => v.id === d.run);
    const gate = view?.openGates
      .filter((g) => g.name === d.gate)
      .sort((a, b) => a.occ - b.occ)[0];
    const declared = gate?.options ?? [];
    if (!view || !gate || !declared.includes(d.decision)) {
      // Fail closed (§8), same as the CLI: unknown run, unopened gate, or an
      // undeclared option is dropped and reported, never guessed.
      const why = !view ? "unknown run" : !gate ? "gate not open" : `not in options: ${declared.join(", ")}`;
      actions.push({ run: d.run, action: "surface-drop", detail: `${d.gate}=${d.decision} (${why})` });
      continue;
    }
    try {
      writeDecision(view.dir, {
        name: gate.name,
        occ: gate.occ,
        decision: d.decision,
        note: d.note,
        by: d.by,
        via: s.id,
        ts: new Date().toISOString(),
      });
      actions.push({ run: d.run, action: "surface-decision", detail: `${gate.name}.${gate.occ}=${d.decision} by ${d.by}` });
    } catch {
      actions.push({ run: d.run, action: "surface-skip", detail: `${gate.name}.${gate.occ} decision already pending` });
    }
  }

  if (res.cursor != null) writeCursor(base, s.id, res.cursor);
}

export async function tickOnce(
  base: string,
  entry: string,
  sync: boolean,
  surfaces: Surface[] = [],
): Promise<TickAction[]> {
  const runsDir = path.join(base, "runs");
  if (!fs.existsSync(runsDir) && surfaces.length === 0) return [];
  fs.mkdirSync(runsDir, { recursive: true });
  if (!acquireTickLock(base)) return [{ run: "-", action: "skip-running", detail: "another tick holds the lock" }];
  const actions: TickAction[] = [];
  try {
    // 1. Surfaces first, so a decision polled this tick resumes its run this tick.
    for (const s of surfaces) await driveSurface(base, runsDir, s, actions);

    // 2. Reconcile every run (§6.1).
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

    // 3. Project — after reconcile, so projections see post-resume state where
    // sync; detached resumes surface on the next tick. Idempotent, never read
    // back; a failing surface must not block reconciliation (it already ran).
    for (const s of surfaces) {
      if (!s.project) continue;
      for (const v of runViews(runsDir)) {
        try {
          await s.project(v);
        } catch (e) {
          actions.push({ run: v.id, action: "surface-error", detail: `${s.id} project: ${errMsg(e)}` });
        }
      }
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

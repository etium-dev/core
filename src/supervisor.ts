// The supervisor: one per active run, exits on park/complete (§6.1). Attach is
// crash-only — it reconciles whatever the previous process left behind.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledLoopsDir } from "./adapters.ts";
import { executeLoop, type EngineOutcome } from "./engine.ts";
import { LedgerWriter, loadState, writeStateCache, sha256 } from "./ledger.ts";
import { acquireLock, isLockLive, lockPath, readLock, releaseLock } from "./lock.ts";
import { activeChildren, checkHarnessAuth, runStep, type StepAuthResult } from "./runner.ts";
import { ETIUM_VERSION, type LoopFn } from "./types.ts";

export interface LoopConfig {
  loop: string; // absolute module path (or builtin already resolved to one)
  params: Record<string, string>;
  workspace: string;
  preapprove?: string[];
  maxSteps?: number;
}

export function loopConfigPath(runDir: string): string {
  return path.join(runDir, "loop.json");
}

// ---------------------------------------------------------------------------
// Run creation (§6.1) — shared by `etium run` and surface-delivered tasks.
// ---------------------------------------------------------------------------

export interface CreateRunSpec {
  task: string; // task.md content
  loop: string; // builtin name or path to a loop module
  params?: Record<string, string>;
  workspace?: string; // default: <runDir>/ws
  /** Give the run its own git worktree at <base>/worktrees/<run-id> on a fresh
   * branch (default `etium/<run-id>` off `base` ?? HEAD) — one branch per
   * attempt (§4). Mutually exclusive with `workspace`. */
  worktree?: { repo: string; base?: string; branch?: string };
  preapprove?: string[];
  maxSteps?: number;
  idSeed?: string; // slug source for the run id; default: the task text
}

function slug(s: string): string {
  return (
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "run"
  );
}

/** Resolve a builtin loop name or user path to an absolute module path. */
export function resolveLoop(ref: string): string {
  if (!ref.includes("/") && !ref.includes(".")) {
    const cands = [path.join(bundledLoopsDir(), `${ref}.js`), path.join(bundledLoopsDir(), `${ref}.ts`)];
    const hit = cands.find((p) => fs.existsSync(p));
    if (!hit) throw new Error(`unknown builtin loop "${ref}"`);
    return hit;
  }
  const p = path.resolve(ref);
  if (!fs.existsSync(p)) throw new Error(`loop not found: ${p}`);
  return p;
}

export function createRun(base: string, spec: CreateRunSpec): { runId: string; runDir: string } {
  if (!spec.task) throw new Error("run creation needs task text");
  if (spec.worktree && spec.workspace)
    throw new Error("worktree and workspace are mutually exclusive");
  base = path.resolve(base);
  const loopPath = resolveLoop(spec.loop);
  const date = new Date().toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  const runId = `${date}-${slug(spec.idSeed ?? spec.task)}-${rand}`;
  const runDir = path.join(base, "runs", runId);

  // Worktree first: it is the one step that can fail for external reasons, and
  // an aborted creation must leave no half-made run behind (§6.1 crash-only).
  let workspace: string;
  let worktree: { repo: string; branch: string; base: string } | undefined;
  if (spec.worktree) {
    const repo = path.resolve(spec.worktree.repo);
    const branch = spec.worktree.branch ?? `etium/${runId}`;
    const baseRef = spec.worktree.base ?? "HEAD";
    workspace = path.join(base, "worktrees", runId);
    fs.mkdirSync(path.dirname(workspace), { recursive: true });
    const r = spawnSync("git", ["-C", repo, "worktree", "add", "-b", branch, workspace, baseRef], {
      encoding: "utf8",
    });
    if (r.status !== 0)
      throw new Error(`git worktree add failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
    worktree = { repo, branch, base: baseRef };
  } else {
    workspace = spec.workspace ? path.resolve(spec.workspace) : path.join(runDir, "ws");
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "task.md"), spec.task);
  fs.mkdirSync(workspace, { recursive: true });
  const wsLink = path.join(runDir, "workspace");
  if (!fs.existsSync(wsLink)) {
    try {
      fs.symlinkSync(workspace, wsLink);
    } catch {
      /* e.g. FS without symlinks; the path is in loop.json regardless */
    }
  }

  const params = spec.params ?? {};
  const cfg: LoopConfig = {
    loop: loopPath,
    params,
    workspace,
    preapprove: spec.preapprove ?? [],
    maxSteps: spec.maxSteps,
  };
  fs.writeFileSync(loopConfigPath(runDir), JSON.stringify(cfg, null, 2));

  const w = new LedgerWriter(runDir, runId, 0);
  w.append("run.created", {
    taskSha256: sha256(spec.task),
    loop: loopPath,
    params,
    workspace,
    worktree,
    etiumVersion: ETIUM_VERSION,
  });
  w.close();
  writeStateCache(runDir, loadState(runDir));
  return { runId, runDir };
}

export type SuperviseOutcome = EngineOutcome | "already-running" | "already-completed";

export async function supervise(runDir: string): Promise<SuperviseOutcome> {
  runDir = path.resolve(runDir);
  const runId = path.basename(runDir);
  let state = loadState(runDir);
  // A run completed `error` stays resumable by explicit attach (`etium resume`)
  // — retry-after-fix, e.g. after authenticating a harness (§6.3). `tick` skips
  // all completed runs on its own, so errors are never retried unattended.
  if (state.completed && state.completed.status !== "error") {
    writeStateCache(runDir, state);
    return "already-completed";
  }

  const pre = readLock(runDir);
  const preLive = isLockLive(runDir, pre);
  if (preLive) return "already-running";
  if (!acquireLock(runDir)) return "already-running";

  const writer = new LedgerWriter(runDir, runId, state.seq);
  const onSignal = () => {
    for (const pid of activeChildren) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    writer.close();
    releaseLock(runDir);
    process.exit(130);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    if (pre && !preLive) {
      let lockAgeMs: number | undefined;
      try {
        lockAgeMs = Date.now() - fs.statSync(lockPath(runDir)).mtimeMs;
      } catch {
        /* lock already cleared by acquire */
      }
      writer.append("run.interrupted", {
        reason: "stale-lock",
        pid: pre.pid,
        host: pre.host,
        lockAgeMs,
      });
    } else if (state.status === "running") {
      // A prior supervisor died between releasing artifacts and recording an
      // outcome (e.g. SIGTERM). Same recovery path.
      writer.append("run.interrupted", { reason: "no-lock" });
    }

    writer.append("supervisor.started", { pid: process.pid, host: os.hostname() });

    const cfg = JSON.parse(fs.readFileSync(loopConfigPath(runDir), "utf8")) as LoopConfig;
    fs.mkdirSync(cfg.workspace, { recursive: true });
    const mod = (await import(pathToFileURL(cfg.loop).href)) as { default: LoopFn };
    if (typeof mod.default !== "function")
      throw new Error(`loop module has no default export function: ${cfg.loop}`);

    let task = "";
    try {
      task = fs.readFileSync(path.join(runDir, "task.md"), "utf8");
    } catch {
      /* pre-task runs (tests) */
    }
    const authCache = new Map<string, StepAuthResult>(); // per attach (§6.3)
    const outcome = await executeLoop({
      runDir,
      runId,
      task,
      writer,
      state,
      loopFn: mod.default,
      loopDir: path.dirname(cfg.loop),
      params: cfg.params ?? {},
      workspace: cfg.workspace,
      preapprovals: cfg.preapprove ?? [],
      runStepImpl: runStep,
      stepAuth: (h) => {
        let r = authCache.get(h);
        if (r === undefined) {
          r = checkHarnessAuth(h);
          authCache.set(h, r);
        }
        return r;
      },
      maxSteps: cfg.maxSteps,
    });
    return outcome;
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    writer.close();
    releaseLock(runDir);
    try {
      state = loadState(runDir);
      writeStateCache(runDir, state);
    } catch {
      /* projection failure must not mask the outcome */
    }
  }
}

/** Kill any live supervisor and mark the run abandoned (or superseded).
 * Shared by `etium abandon` and surface-observed lifecycle facts (§10.3).
 * Errored runs stay abandonable (§6.3); other completed runs are left alone. */
export async function abandonRun(
  runDir: string,
  reason?: string,
  status: "abandoned" | "superseded" = "abandoned",
): Promise<"abandoned" | "already-completed"> {
  runDir = path.resolve(runDir);
  const lock = readLock(runDir);
  if (isLockLive(runDir, lock)) {
    try {
      process.kill(lock!.pid, "SIGTERM");
    } catch {
      /* raced */
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isLockLive(runDir, readLock(runDir)))
      await new Promise((r) => setTimeout(r, 100));
    if (isLockLive(runDir, readLock(runDir))) {
      try {
        process.kill(lock!.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        fs.unlinkSync(lockPath(runDir));
      } catch {
        /* gone */
      }
    }
  }
  const state = loadState(runDir);
  if (state.completed && state.completed.status !== "error") return "already-completed";
  const w = new LedgerWriter(runDir, state.run, state.seq);
  w.append("run.completed", { status, summary: reason });
  w.close();
  writeStateCache(runDir, loadState(runDir));
  return "abandoned";
}

/** Spawn a detached supervisor and return immediately (§6.1). `entry` is the
 * CLI module path; stdout/stderr go to <run>/supervisor.log. */
export function superviseDetached(runDir: string, entry: string): void {
  const log = fs.openSync(path.join(runDir, "supervisor.log"), "a");
  const child = spawn(process.execPath, [entry, "_supervise", runDir], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
}

export function taskSha(runDir: string): string {
  return sha256(fs.readFileSync(path.join(runDir, "task.md")));
}

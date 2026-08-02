// The supervisor: one per active run, exits on park/complete (§6.1). Attach is
// crash-only — it reconciles whatever the previous process left behind.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { executeLoop, type EngineOutcome } from "./engine.ts";
import { LedgerWriter, loadState, writeStateCache, sha256 } from "./ledger.ts";
import { acquireLock, isLockLive, lockPath, readLock, releaseLock } from "./lock.ts";
import { activeChildren, checkHarnessAuth, runStep, type StepAuthResult } from "./runner.ts";
import type { LoopFn } from "./types.ts";

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

    const authCache = new Map<string, StepAuthResult>(); // per attach (§6.3)
    const outcome = await executeLoop({
      runDir,
      runId,
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

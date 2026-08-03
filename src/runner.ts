// Step execution (§6.3–§6.4). The runner owns everything an adapter must not:
// spawning, raw capture with redaction, budget enforcement, kill, grading,
// artifact collection, compression.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAdapter, resolve as resolveAdapter } from "./adapters.ts";
import type { RunStepArgs, RunStepOutcome } from "./engine.ts";
import { parseDuration, type Usage } from "./types.ts";

const DEFAULT_STALL_WARN_MS = 15 * 60_000;

/** PIDs of live step children; the supervisor kills these on SIGTERM/SIGINT. */
export const activeChildren = new Set<number>();

export interface EnvResolution {
  env: Record<string, string>;
  secrets: string[]; // values to redact from raw
}

const AGENT_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ"];
const SECRET_NAME = /(TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL)/i;

/** §9: least environment per step. `agent` allowlists basics plus the adapter's
 * declared model-credential vars (ADR-007) — publication credentials never;
 * `host` inherits everything and redacts secret-looking values from raw. */
export function resolveEnv(
  spec?: { profile?: "agent" | "host"; add?: Record<string, string> },
  declaredEnv?: string[],
): EnvResolution {
  const profile = spec?.profile ?? "agent";
  let env: Record<string, string>;
  const secrets: string[] = [];
  if (profile === "host") {
    env = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(env))
      if (SECRET_NAME.test(k) && v && v.length >= 6) secrets.push(v);
  } else {
    env = {};
    for (const k of AGENT_ALLOWLIST) if (process.env[k]) env[k] = process.env[k]!;
    for (const k of declaredEnv ?? []) if (process.env[k]) env[k] = process.env[k]!;
  }
  // Declared values are secrets by declaration, not by the name heuristic (§9).
  for (const k of declaredEnv ?? []) {
    const v = process.env[k];
    if (v && v.length >= 6) secrets.push(v);
  }
  for (const [k, v] of Object.entries(spec?.add ?? {})) {
    env[k] = v;
    if (SECRET_NAME.test(k) && v.length >= 6) secrets.push(v);
  }
  return { env, secrets };
}

export type StepAuthResult = { ok: true; authEnv: string[] } | { ok: false; detail: string };

/** Pre-spawn auth gate (§6.3, ADR-007). Uncached — the supervisor caches per
 * attach. Definitive failures (non-zero exit, missing binary) block; an
 * indeterminate check (timeout) proceeds with a warning so unattended resumes
 * never hang on a flaky check. */
export function checkHarnessAuth(harness: string, timeoutMs = 10_000): StepAuthResult {
  const adapter = getAdapter(harness);
  const authEnv = (adapter.auth?.env ?? []).filter((k) => process.env[k] !== undefined);
  // Presence before auth: a harness that isn't installed fails here, legibly,
  // instead of at spawn. Surface-created runs never pass through `etium configure`'s
  // checks, so this gate is where "pi isn't on this machine" must be caught.
  if (adapter.bin) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${adapter.bin}`], { stdio: "ignore", timeout: timeoutMs });
    if (found.status !== 0)
      return { ok: false, detail: `harness ${harness} is not installed (no \`${adapter.bin}\` on PATH) — install it, then: etium resume` };
  }
  const check = adapter.auth?.check;
  if (!check) return { ok: true, authEnv };
  const remedy = adapter.auth?.remedy ? ` — run: ${adapter.auth.remedy}` : "";
  const r = spawnSync(check.cmd, check.args, { stdio: "ignore", timeout: timeoutMs });
  const errCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === "ETIMEDOUT" || r.signal) {
    process.stderr.write(`etium: auth check for ${harness} did not complete; proceeding\n`);
    return { ok: true, authEnv };
  }
  if (r.error)
    return { ok: false, detail: `harness ${harness} not runnable (${check.cmd}: ${errCode ?? r.error.message})${remedy}` };
  if (r.status !== 0) return { ok: false, detail: `harness ${harness} not authenticated${remedy}` };
  return { ok: true, authEnv };
}

function redact(line: string, secrets: string[]): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("(?:.*)");
  return new RegExp(`^${esc}$`);
}

function collectArtifacts(patterns: string[], workspace: string, stepDir: string, runDir: string): string[] {
  const destDir = path.join(stepDir, "artifacts");
  const out: string[] = [];
  let all: string[] | null = null;
  for (const pat of patterns) {
    let matches: string[];
    if (!pat.includes("*")) {
      matches = fs.existsSync(path.join(workspace, pat)) ? [pat] : [];
    } else {
      if (all === null)
        all = (fs.readdirSync(workspace, { recursive: true }) as string[]).map((p) =>
          p.split(path.sep).join("/"),
        );
      const re = globToRegExp(pat);
      matches = all.filter((p) => re.test(p));
    }
    for (const rel of matches) {
      const src = path.join(workspace, rel);
      if (!fs.statSync(src).isFile()) continue;
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      out.push(path.relative(runDir, dest));
    }
  }
  return out;
}

function compressRaw(rawPath: string): string {
  const r = spawnSync("zstd", ["-q", "--rm", "-f", rawPath], { stdio: "ignore" });
  return r.status === 0 && fs.existsSync(rawPath + ".zst") ? rawPath + ".zst" : rawPath;
}

/** Split a byte stream into lines, tolerating chunk boundaries. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let buf = "";
  return {
    push(chunk: Buffer) {
      buf += chunk.toString("utf8");
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf.length) onLine(buf);
      buf = "";
    },
  };
}

export async function runStep(a: RunStepArgs): Promise<RunStepOutcome> {
  const { adapter, parse } = resolveAdapter(a.opts.harness, a.opts.inner);
  const built = adapter.build({
    prompt: a.prompt,
    command: a.opts.command,
    model: a.opts.model,
    workspace: a.workspace,
    fixture: a.opts.fixture,
    inner: a.opts.inner,
  });
  const { env, secrets } = resolveEnv(a.opts.env, adapter.auth?.env);
  Object.assign(env, built.env ?? {});

  const rawPath = path.join(a.stepDir, "raw.jsonl");
  const rawFd = fs.openSync(rawPath, "w");
  const hash = createHash("sha256");
  let rawLines = 0;

  const wallMs = parseDuration(a.opts.budget?.wall);
  const stallMs = parseDuration(a.opts.budget?.stallWarn) ?? DEFAULT_STALL_WARN_MS;
  const tokenBudget = a.opts.budget?.tokens;
  const costBudget = a.opts.budget?.costUsd;

  const usage: Required<Usage> = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  let budgetHit: RunStepOutcome["budgetHit"];

  const child = spawn(built.cmd, built.args, {
    cwd: a.workspace,
    env,
    detached: true, // own process group so we can kill the whole tree
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Spawn failure (ENOENT, EACCES, bad interpreter) must become a step error,
  // never an unhandled 'error' event that kills the supervisor mid-attach.
  let spawnError: NodeJS.ErrnoException | undefined;
  child.stdin.on("error", () => {
    /* the child 'error' event carries the cause */
  });
  if (built.stdin !== undefined) child.stdin.write(built.stdin);
  child.stdin.end();
  if (child.pid) activeChildren.add(child.pid);

  const killTree = (why: NonNullable<RunStepOutcome["budgetHit"]>) => {
    if (budgetHit) return;
    budgetHit = why;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const wallTimer = wallMs !== undefined ? setTimeout(() => killTree("wall"), wallMs) : undefined;
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      a.emitWarning("stall", `no harness output for ${Math.round(stallMs / 1000)}s`);
      armStall(); // warn again next period; never kill on stall (§6.4)
    }, stallMs);
  };
  armStall();

  const onLine = (line: string) => {
    const safe = redact(line, secrets);
    fs.writeSync(rawFd, safe + "\n");
    hash.update(safe + "\n");
    rawLines++;
    armStall();
    if (!parse) return;
    const events = parse(safe);
    if (!events) return;
    for (const ev of events) {
      if (ev.kind === "usage") {
        usage.tokensIn += ev.usage.tokensIn ?? 0;
        usage.tokensOut += ev.usage.tokensOut ?? 0;
        usage.costUsd += ev.usage.costUsd ?? 0;
        a.emitActivity("usage", `+${(ev.usage.tokensIn ?? 0) + (ev.usage.tokensOut ?? 0)} tokens`, ev.usage, rawLines);
        if (tokenBudget !== undefined && usage.tokensIn + usage.tokensOut > tokenBudget) killTree("tokens");
        if (costBudget !== undefined && usage.costUsd > costBudget) killTree("cost");
      } else if (ev.kind === "message") {
        a.emitActivity("message", ev.summary, undefined, rawLines);
      } else if (ev.kind === "tool") {
        a.emitActivity("tool", `${ev.name}: ${ev.summary}`, undefined, rawLines);
      } else {
        a.emitActivity("lifecycle", ev.state, undefined, rawLines);
      }
    }
  };
  const stdoutSplit = lineSplitter(onLine);
  child.stdout.on("data", (c: Buffer) => stdoutSplit.push(c));
  // stderr is diagnostics, not the harness stream: kept separately, still redacted.
  const errPath = path.join(a.stepDir, "stderr.log");
  const errFd = fs.openSync(errPath, "w");
  const stderrSplit = lineSplitter((l) => fs.writeSync(errFd, redact(l, secrets) + "\n"));
  child.stderr.on("data", (c: Buffer) => stderrSplit.push(c));

  const { exit, signal } = await new Promise<{ exit: number | null; signal: string | null }>(
    (res) => {
      child.on("close", (code, sig) => res({ exit: code, signal: sig }));
      child.on("error", (e: NodeJS.ErrnoException) => {
        spawnError = e; // 'close' may never fire for a failed spawn
        res({ exit: null, signal: null });
      });
    },
  );
  if (child.pid) activeChildren.delete(child.pid);
  stdoutSplit.flush();
  stderrSplit.flush();
  if (spawnError) {
    const why = `spawn ${built.cmd} failed (${spawnError.code ?? spawnError.message}) — is ${built.cmd} installed?`;
    fs.writeSync(errFd, why + "\n");
    a.emitActivity("lifecycle", why, undefined, rawLines);
  }
  if (wallTimer) clearTimeout(wallTimer);
  if (stallTimer) clearTimeout(stallTimer);
  fs.closeSync(rawFd);
  fs.closeSync(errFd);

  const rawSha256 = hash.digest("hex");
  const finalRaw = compressRaw(rawPath);

  const metered = usage.tokensIn + usage.tokensOut + usage.costUsd > 0;
  let status: RunStepOutcome["status"];
  if (budgetHit) status = "budget";
  else if (spawnError) status = "error";
  else if (signal) status = "killed";
  else if (exit === 0) status = "ok";
  else status = "error";

  // Grade (§10.4): exit 0 => passed; stdout captured as an artifact.
  let passed: boolean | undefined;
  const artifacts = collectArtifacts(a.opts.artifacts ?? [], a.workspace, a.stepDir, a.runDir);
  if (a.opts.grade && status !== "budget" && status !== "killed") {
    const g = spawnSync("/bin/sh", ["-c", a.opts.grade], {
      cwd: a.workspace,
      env,
      encoding: "utf8",
      timeout: 10 * 60_000,
    });
    passed = g.status === 0;
    const gradePath = path.join(a.stepDir, "artifacts", "grade.txt");
    fs.mkdirSync(path.dirname(gradePath), { recursive: true });
    // The grader inherits the step env; its output is redacted like raw (§9).
    fs.writeFileSync(gradePath, redact((g.stdout ?? "") + (g.stderr ?? ""), secrets));
    artifacts.push(path.relative(a.runDir, gradePath));
  } else if (a.opts.harness === "exec") {
    passed = status === "ok";
  }

  return {
    status,
    exit,
    signal,
    usage: metered ? usage : undefined,
    rawFile: path.relative(a.runDir, finalRaw),
    rawSha256,
    artifacts,
    passed,
    budgetHit,
  };
}

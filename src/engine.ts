// Replay-memoized loop execution (§6.2). On every attach the loop function runs
// from the top; completed work is returned from the ledger, new work executes.

import * as path from "node:path";
import * as fs from "node:fs";
import { setImmediate as flushTurn } from "node:timers/promises";
import { sha256, type LedgerWriter } from "./ledger.ts";
import { listDecisions, removeDecision, type DecisionFile } from "./lock.ts";
import {
  DEFAULT_GATE_OPTIONS,
  stepKey,
  type Decision,
  type GateRecord,
  type GateResult,
  type LoopFn,
  type PromptSpec,
  type Run,
  type RunState,
  type StepCompletedData,
  type StepOptions,
  type StepResult,
  type Usage,
} from "./types.ts";

export class EtiumError extends Error {}
export class DivergenceError extends EtiumError {}
export class AbandonSignal extends Error {
  reason?: string;
  constructor(reason?: string) {
    super(reason ?? "abandoned");
    this.reason = reason;
  }
}

export interface RunStepArgs {
  runDir: string;
  stepDir: string;
  name: string;
  occ: number;
  opts: StepOptions;
  prompt: string;
  workspace: string;
  emitActivity(
    kind: "message" | "tool" | "usage" | "lifecycle",
    summary: string,
    usage: Usage | undefined,
    rawLine: number,
  ): void;
  emitWarning(kind: "stall" | "approaching", detail: string): void;
}
export interface RunStepOutcome {
  status: StepCompletedData["status"];
  exit?: number | null;
  signal?: string | null;
  usage?: Usage;
  rawFile: string;
  rawSha256: string;
  artifacts: string[];
  passed?: boolean;
  budgetHit?: "wall" | "tokens" | "cost";
}
export type RunStepImpl = (args: RunStepArgs) => Promise<RunStepOutcome>;

/** Pre-spawn auth gate (§6.3): consulted on memo miss before `step.started` is
 * appended. Structurally matches runner.checkHarnessAuth. */
export type StepAuthFn = (
  harness: string,
) => { ok: true; authEnv: string[] } | { ok: false; detail: string };

export interface EngineCtx {
  runDir: string;
  runId: string;
  task: string;
  writer: LedgerWriter;
  state: RunState; // folded before attach
  loopFn: LoopFn;
  loopDir: string;
  params: Record<string, string>;
  workspace: string;
  preapprovals: string[];
  runStepImpl: RunStepImpl;
  stepAuth?: StepAuthFn;
  maxSteps?: number; // per-run guard; default 100
  pollMs?: number; // test hook
}

export type EngineOutcome = "done" | "parked" | "abandoned" | "error";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

function promptRef(
  spec: PromptSpec | undefined,
  resolveTemplate?: (file: string) => string | null,
): string {
  if (spec === undefined) return "none";
  if (typeof spec === "string") return `sha:${sha256(spec)}`;
  // Templates hash their *content* (pre-interpolation, pre-notes): editing a
  // template mid-run is a config change and must diverge loudly (§6.2).
  const found = resolveTemplate?.(spec.__template);
  return `t:${spec.__template}:${found === null || found === undefined ? "missing" : sha256(found)}`;
}

/** Config digest for divergence detection. Operator notes are runtime input, not
 * loop config, and are deliberately excluded (§6.2 / DECISIONS ADR-002). */
export function configDigest(
  opts: StepOptions,
  resolveTemplate?: (file: string) => string | null,
): string {
  return sha256(
    stableStringify({
      harness: opts.harness,
      model: opts.model,
      prompt: promptRef(opts.prompt, resolveTemplate),
      command: opts.command,
      grade: opts.grade,
      artifacts: opts.artifacts,
      budget: opts.budget,
      env: opts.env && { profile: opts.env.profile, add: Object.keys(opts.env.add ?? {}).sort() },
      fixture: opts.fixture,
      inner: opts.inner,
    }),
  ).slice(0, 16);
}

function renderTemplate(text: string, params: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => params[k] ?? "");
}

export async function executeLoop(ctx: EngineCtx): Promise<EngineOutcome> {
  const { writer, state } = ctx;
  const pollMs = ctx.pollMs ?? 20;
  const maxSteps = ctx.maxSteps ?? 100;

  const occCounters = new Map<string, number>();
  const visited = new Set<string>();
  const notes = [...state.pendingNotes];
  let stepCount = state.stepCount;
  let active = 0;
  const pendingGates = new Map<
    string,
    { name: string; occ: number; resolve: (g: GateResult) => void }
  >();
  const consumedPreapprovals = new Set<string>();

  const nextOcc = (kind: string, name: string): number => {
    const k = `${kind}:${name}`;
    const n = occCounters.get(k) ?? 0;
    occCounters.set(k, n + 1);
    return n;
  };

  const gateRec = (name: string, occ: number): GateRecord | undefined =>
    state.gates.get(`${name}.${occ}`);

  const decideGate = (name: string, occ: number, d: Omit<DecisionFile, "name" | "occ">) => {
    writer.append("gate.decided", {
      name,
      occ,
      decision: d.decision,
      note: d.note,
      by: d.by,
      via: d.via,
    });
    const rec = gateRec(name, occ) ?? { name, occ };
    rec.decided = { name, occ, decision: d.decision, note: d.note, by: d.by, via: d.via };
    state.gates.set(`${name}.${occ}`, rec);
    if (d.note) notes.push(d.note);
    const waiter = pendingGates.get(stepKey("g", name, occ));
    if (waiter) {
      pendingGates.delete(stepKey("g", name, occ));
      waiter.resolve({ decision: d.decision, note: d.note, by: d.by });
    }
  };

  const ingestMailbox = () => {
    for (const d of listDecisions(ctx.runDir)) {
      const rec = gateRec(d.name, d.occ);
      if (rec?.opened && !rec.decided) {
        // The ledger's recorded option set is the validation authority (§8).
        const declared = rec.opened.options ?? DEFAULT_GATE_OPTIONS;
        if (declared.includes(d.decision)) {
          decideGate(d.name, d.occ, d);
        } else {
          process.stderr.write(
            `etium: dropping decision "${d.decision}" for ${d.name}.${d.occ} (declared options: ${declared.join(", ")}) — decisions fail closed\n`,
          );
        }
      } else {
        process.stderr.write(
          `etium: dropping decision for ${d.name}.${d.occ} (gate not open) — decisions fail closed\n`,
        );
      }
      removeDecision(ctx.runDir, d.name, d.occ);
    }
  };

  const readTemplate = (file: string): string | null => {
    const candidates = [path.resolve(ctx.loopDir, file), path.resolve(ctx.workspace, file)];
    const found = candidates.find((p) => fs.existsSync(p));
    return found === undefined ? null : fs.readFileSync(found, "utf8");
  };

  const resolvePrompt = (spec: PromptSpec | undefined): { text: string; injected: number } => {
    let text: string;
    if (spec === undefined) text = "";
    else if (typeof spec === "string") text = spec;
    else {
      const raw = readTemplate(spec.__template);
      if (raw === null)
        throw new EtiumError(
          `template not found: ${spec.__template} (looked in loop dir and workspace)`,
        );
      text = renderTemplate(raw, ctx.params);
    }
    let injected = 0;
    if (notes.length > 0) {
      text += `\n\n---\nOperator notes:\n${notes.map((n) => `- ${n}`).join("\n")}\n`;
      injected = notes.length;
      notes.length = 0;
    }
    return { text, injected };
  };

  const materialize = (name: string, occ: number, c: StepCompletedData): StepResult => {
    const abs = c.artifacts.map((a) => path.resolve(ctx.runDir, a));
    return {
      name,
      occ,
      status: c.status,
      exit: c.exit,
      passed: c.passed,
      usage: c.usage,
      artifacts: abs,
      artifact(basename: string) {
        const hit = abs.find((a) => path.basename(a) === basename || a.endsWith(basename));
        if (!hit) throw new EtiumError(`step ${name}.${occ}: no artifact named ${basename}`);
        return hit;
      },
    };
  };

  const run: Run = {
    id: ctx.runId,
    task: ctx.task,
    params: ctx.params,
    workspace: ctx.workspace,
    t: (file: string) => ({ __template: file }),

    async step(name: string, opts: StepOptions): Promise<StepResult> {
      const occ = nextOcc("s", name);
      const key = stepKey("s", name, occ);
      visited.add(key);
      const digest = configDigest(opts, readTemplate);
      const hist = state.steps.get(`${name}.${occ}`);
      if (hist?.completed) {
        const prior = hist.started?.digest;
        if (prior && prior !== digest)
          throw new DivergenceError(
            `step ${name}.${occ}: loop config changed since it was recorded ` +
              `(recorded ${prior}, replayed ${digest}). Rename the step or use \`etium redo\` (M1).`,
          );
        return materialize(name, occ, hist.completed);
      }
      if (stepCount >= maxSteps)
        throw new EtiumError(`per-run step guard exceeded (${maxSteps}); raise maxSteps deliberately`);

      // Auth gate before anything is recorded for this key (§6.3): a failure
      // consumes no occurrence, so a fixed credential resumes into a clean
      // first execution instead of replaying a memoized failure.
      let authEnv: string[] | undefined;
      if (ctx.stepAuth) {
        const auth = ctx.stepAuth(opts.harness);
        if (!auth.ok) throw new EtiumError(auth.detail);
        authEnv = auth.authEnv.length > 0 ? auth.authEnv : undefined;
      }

      active++;
      try {
        const { text: prompt, injected } = resolvePrompt(opts.prompt);
        const started = writer.append("step.started", {
          name,
          occ,
          harness: opts.harness,
          model: opts.model,
          promptSha256: sha256(prompt),
          envProfile: opts.env?.profile ?? "agent",
          authEnv,
          budget: opts.budget ?? {},
          digest,
          unmetered: opts.harness === "exec" || undefined,
          notes: injected || undefined,
        });
        stepCount++;
        const stepDirName = `${String(started.seq).padStart(3, "0")}-${name}.${occ}`;
        const stepDir = path.join(ctx.runDir, "steps", stepDirName);
        fs.mkdirSync(stepDir, { recursive: true });
        fs.writeFileSync(path.join(stepDir, "prompt.md"), prompt);

        const stepRel = (p: string) => path.relative(ctx.runDir, p);
        const outcome = await ctx.runStepImpl({
          runDir: ctx.runDir,
          stepDir,
          name,
          occ,
          opts,
          prompt,
          workspace: ctx.workspace,
          emitActivity: (kind, summary, usage, rawLine) =>
            writer.append("step.activity", {
              step: { name, occ },
              kind,
              summary,
              usage,
              raw: { file: path.join(stepRel(stepDir), "raw.jsonl"), line: rawLine },
            }),
          emitWarning: (kind, detail) =>
            writer.append("budget.warning", { step: { name, occ }, kind, detail }),
        });

        if (outcome.budgetHit)
          writer.append("budget.exceeded", {
            step: { name, occ },
            budget: outcome.budgetHit,
            action: "killed",
          });
        const completed: StepCompletedData = {
          step: { name, occ },
          status: outcome.status,
          exit: outcome.exit ?? null,
          signal: outcome.signal ?? null,
          usage: outcome.usage,
          rawFile: outcome.rawFile,
          rawSha256: outcome.rawSha256,
          artifacts: outcome.artifacts,
          passed: outcome.passed,
        };
        writer.append("step.completed", completed);
        state.steps.set(`${name}.${occ}`, {
          name,
          occ,
          started: undefined,
          completed,
        });
        return materialize(name, occ, completed);
      } finally {
        active--;
      }
    },

    async gate(name: string, opts?: { show?: string[]; options?: string[]; reason?: string }): Promise<GateResult> {
      const occ = nextOcc("g", name);
      const key = stepKey("g", name, occ);
      visited.add(key);
      const options = opts?.options ?? DEFAULT_GATE_OPTIONS;
      if (options.length === 0 || options.some((o) => !o) || new Set(options).size !== options.length)
        throw new EtiumError(`gate ${name}: options must be distinct non-empty strings`);
      const rec = gateRec(name, occ);
      if (rec?.decided)
        return { decision: rec.decided.decision, note: rec.decided.note, by: rec.decided.by };
      if (!rec?.opened) {
        const data = { name, occ, options, show: opts?.show ?? [], ...(opts?.reason && { reason: opts.reason }) };
        writer.append("gate.opened", data);
        state.gates.set(`${name}.${occ}`, { name, occ, opened: data });
      } else {
        const recorded = rec.opened.options ?? DEFAULT_GATE_OPTIONS;
        if (JSON.stringify(recorded) !== JSON.stringify(options))
          process.stderr.write(
            `etium: warning: gate ${name}.${occ} options changed in loop code (ledger: ${recorded.join(", ")}; code: ${options.join(", ")}) — the ledger's set governs decisions\n`,
          );
      }
      const declared = gateRec(name, occ)!.opened!.options ?? DEFAULT_GATE_OPTIONS;
      if (ctx.preapprovals.includes(name) && !consumedPreapprovals.has(`${name}.${occ}`)) {
        consumedPreapprovals.add(`${name}.${occ}`);
        if (!declared.includes("approve"))
          throw new EtiumError(
            `preapproval for gate "${name}" is invalid: declared options are [${declared.join(", ")}], which do not include "approve"`,
          );
        decideGate(name, occ, {
          decision: "approve" as Decision,
          by: "preapproval",
          via: "preapproval",
          ts: new Date().toISOString(),
        });
        const d = gateRec(name, occ)!.decided!;
        return { decision: d.decision, note: d.note, by: d.by };
      }
      return new Promise<GateResult>((resolve) => {
        pendingGates.set(key, { name, occ, resolve });
      });
    },

    async effect<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      const occ = nextOcc("e", name);
      const key = stepKey("e", name, occ);
      visited.add(key);
      const hist = state.effects.get(`${name}.${occ}`);
      if (hist) return hist.value as T;
      active++;
      try {
        const value = await fn();
        JSON.stringify(value); // small-JSON contract: must be serializable
        writer.append("effect.recorded", { name, occ, value });
        state.effects.set(`${name}.${occ}`, { name, occ, value });
        return value;
      } finally {
        active--;
      }
    },

    abandon(reason?: string): Promise<never> {
      throw new AbandonSignal(reason);
    },
  };

  // -------------------------------------------------------------------------
  // Drive the loop and watch for quiescence (§6.5)
  // -------------------------------------------------------------------------

  ingestMailbox();

  type Settled =
    | { kind: "done" }
    | { kind: "abandoned"; reason?: string }
    | { kind: "error"; err: unknown };
  let settled: Settled | null = null;
  void (async () => {
    try {
      await ctx.loopFn(run);
      settled = { kind: "done" };
    } catch (e) {
      settled = e instanceof AbandonSignal ? { kind: "abandoned", reason: e.reason } : { kind: "error", err: e };
    }
  })();

  let idlePolls = 0;
  let pollN = 0;
  for (;;) {
    await sleep(pollMs);
    pollN++;
    if (settled) break;
    if (pendingGates.size > 0 && pollN % 25 === 0) ingestMailbox();
    if (active === 0 && pendingGates.size > 0) {
      await flushTurn();
      if (!settled && active === 0 && pendingGates.size > 0) {
        writer.append("run.parked", {
          gates: [...pendingGates.values()].map((g) => ({ name: g.name, occ: g.occ })),
        });
        return "parked";
      }
    }
    if (active === 0 && pendingGates.size === 0) {
      if (++idlePolls > 500) {
        writer.append("run.completed", {
          status: "error",
          summary:
            "loop appears to await a non-etium promise; loops must not use timers, network, or foreign async (see DESIGN §6.2)",
        });
        return "error";
      }
    } else idlePolls = 0;
  }

  const s = settled as Settled;
  if (s.kind === "done") {
    const orphans: string[] = [];
    for (const [k, rec] of state.steps) if (rec.completed && !visited.has(`s:${k}`)) orphans.push(`s:${k}`);
    for (const [k, rec] of state.gates) if (rec.decided && !visited.has(`g:${k}`)) orphans.push(`g:${k}`);
    for (const k of state.effects.keys()) if (!visited.has(`e:${k}`)) orphans.push(`e:${k}`);
    if (orphans.length)
      process.stderr.write(`etium: warning: ledger entries not visited by loop: ${orphans.join(", ")}\n`);
    writer.append("run.completed", {
      status: "done",
      orphans: orphans.length ? orphans : undefined,
    });
    return "done";
  }
  if (s.kind === "abandoned") {
    writer.append("run.completed", { status: "abandoned", summary: s.reason });
    return "abandoned";
  }
  const msg = s.err instanceof Error ? s.err.message : String(s.err);
  writer.append("run.completed", {
    status: "error",
    summary: (s.err instanceof DivergenceError ? "DIVERGENCE: " : "") + msg,
  });
  return "error";
}

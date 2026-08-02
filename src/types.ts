// Etium core types. The JSON shapes here mirror schema/events.schema.json — the
// language-neutral contract. Keep them in sync; the schema wins on conflict.

export const SCHEMA_VERSION = 1;
export const ETIUM_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Ledger envelope and event payloads (§5 of DESIGN.md)
// ---------------------------------------------------------------------------

export interface RawRef {
  file: string; // run-dir-relative path to the raw stream
  line: number; // 1-based line index into the *uncompressed* raw stream
}

export interface StepRef {
  name: string;
  occ: number;
}

export interface Usage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface BudgetSpec {
  wall?: string | number; // "2h", "30m", "45s" or ms
  stallWarn?: string | number; // default 15m; warning only, never kills
  tokens?: number;
  costUsd?: number;
}

export type StepStatus = "ok" | "error" | "killed" | "budget";
export type RunEndStatus = "done" | "abandoned" | "superseded" | "error";
/** A gate decision is one element of the gate's declared option set (§8).
 * Gates without declared options use DEFAULT_GATE_OPTIONS — the binary gate
 * is the degenerate case, not the definition (ADR-008). */
export type Decision = string;
export const DEFAULT_GATE_OPTIONS = ["approve", "reject"];
export type DecisionVia = "cli" | "preapproval" | "github" | "mcp";

export interface RunCreatedData {
  taskSha256: string;
  loop: string; // resolved loop module path or builtin name
  params: Record<string, string>;
  workspace: string;
  etiumVersion: string;
}
export interface SupervisorStartedData {
  pid: number;
  host: string;
}
export interface StepStartedData extends StepRef {
  harness: string;
  model?: string;
  promptSha256: string;
  envProfile: string;
  authEnv?: string[]; // names of adapter-declared vars passed through — never values (§9, ADR-007)
  budget: BudgetSpec;
  digest: string; // config digest for divergence detection (§6.2); authEnv is runtime input, excluded
  unmetered?: boolean;
  notes?: number; // count of operator notes injected into the prompt
}
export interface StepActivityData {
  step: StepRef;
  kind: "message" | "tool" | "usage" | "lifecycle";
  summary: string;
  usage?: Usage; // delta, for kind "usage"
  raw: RawRef;
}
export interface StepCompletedData {
  step: StepRef;
  status: StepStatus;
  exit?: number | null;
  signal?: string | null;
  usage?: Usage; // totals for the step
  rawFile: string; // run-dir-relative; .zst when compressed
  rawSha256: string; // hash of the uncompressed raw stream
  artifacts: string[]; // run-dir-relative paths
  passed?: boolean;
}
export interface GateOpenedData {
  name: string;
  occ: number;
  options: string[]; // the declared answer set; decisions validate against THIS (ledger authority)
  show: string[]; // run-dir-relative artifact paths (or workspace-relative)
}
export interface GateDecidedData {
  name: string;
  occ: number;
  decision: Decision;
  note?: string;
  by: string;
  via: DecisionVia;
}
export interface EffectRecordedData {
  name: string;
  occ: number;
  value: unknown; // small JSON only
}
export interface BudgetWarningData {
  step?: StepRef;
  kind: "stall" | "approaching";
  detail: string;
}
export interface BudgetExceededData {
  step: StepRef;
  budget: "wall" | "tokens" | "cost" | "steps";
  action: "killed";
}
export interface RunParkedData {
  gates: StepRef[]; // open, undecided gates
}
export interface RunInterruptedData {
  pid?: number;
  host?: string;
  lockAgeMs?: number;
  reason: "stale-lock" | "no-lock";
}
export interface RunCompletedData {
  status: RunEndStatus;
  summary?: string;
  orphans?: string[]; // memo keys present in ledger but not visited by the loop
}

export interface EventMap {
  "run.created": RunCreatedData;
  "supervisor.started": SupervisorStartedData;
  "step.started": StepStartedData;
  "step.activity": StepActivityData;
  "step.completed": StepCompletedData;
  "gate.opened": GateOpenedData;
  "gate.decided": GateDecidedData;
  "effect.recorded": EffectRecordedData;
  "budget.warning": BudgetWarningData;
  "budget.exceeded": BudgetExceededData;
  "run.parked": RunParkedData;
  "run.interrupted": RunInterruptedData;
  "run.completed": RunCompletedData;
}
export type EventType = keyof EventMap;

export interface Envelope<T extends EventType = EventType> {
  v: number;
  ts: string; // RFC 3339 UTC
  run: string;
  seq: number;
  type: T;
  data: EventMap[T];
}
export type AnyEnvelope = { [T in EventType]: Envelope<T> }[EventType];

// ---------------------------------------------------------------------------
// Folded run state (§2 invariant 2: a derived, rebuildable projection)
// ---------------------------------------------------------------------------

export interface StepRecord {
  name: string;
  occ: number;
  started?: StepStartedData;
  startedSeq?: number;
  completed?: StepCompletedData;
}
export interface GateRecord {
  name: string;
  occ: number;
  opened?: GateOpenedData;
  decided?: GateDecidedData;
}
export type RunStatus =
  | "created"
  | "running"
  | "parked"
  | "interrupted"
  | "completed";

export interface RunState {
  run: string;
  seq: number; // last seq seen
  created?: RunCreatedData;
  steps: Map<string, StepRecord>; // key `${name}.${occ}`
  gates: Map<string, GateRecord>;
  effects: Map<string, EffectRecordedData>;
  usage: Required<Usage>;
  stepCount: number; // step.started count (per-run steps guard)
  pendingNotes: string[]; // gate notes not yet delivered to a step
  status: RunStatus;
  completed?: RunCompletedData;
  lastEventTs?: string;
}

// ---------------------------------------------------------------------------
// Harness adapters (§10)
// ---------------------------------------------------------------------------

export interface AdapterBuildRequest {
  prompt: string; // fully rendered prompt
  command?: string; // exec harness
  model?: string;
  workspace: string;
  fixture?: string; // replay harness
  inner?: string; // replay harness: whose parser to use
}
export interface BuildResult {
  cmd: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>; // additions only; profile applied by core
}
export type HarnessEvent =
  | { kind: "message"; role: "assistant" | "system"; summary: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "lifecycle"; state: "started" | "exiting" };

export interface HarnessAdapter {
  id: string;
  auth?: {
    // Model auth is harness-owned (MODEL_AUTH.md, ADR-007); this is inert data core acts on.
    env?: string[]; // credential var names passed through into `agent` steps; values always redacted
    check?: { cmd: string; args: string[] }; // cheap, non-interactive; exit 0 = authenticated
    remedy?: string; // the harness's own fix, printed verbatim — e.g. "codex login"
  };
  build(req: AdapterBuildRequest): BuildResult;
  parse?(line: string): HarnessEvent[] | null; // null/undefined = raw-only line
}

// ---------------------------------------------------------------------------
// Loop API (§7)
// ---------------------------------------------------------------------------

export type PromptSpec = string | { __template: string };

export interface EnvSpec {
  profile?: "agent" | "host"; // default "agent" (§9)
  add?: Record<string, string>;
}

export interface StepOptions {
  harness: string;
  model?: string;
  prompt?: PromptSpec;
  command?: string; // exec harness
  fixture?: string; // replay harness
  inner?: string; // replay harness
  grade?: string; // shell command; exit 0 => passed (§10.4)
  artifacts?: string[]; // globs relative to workspace
  budget?: BudgetSpec;
  env?: EnvSpec;
}

export interface StepResult {
  name: string;
  occ: number;
  status: StepStatus;
  exit?: number | null;
  passed?: boolean;
  usage?: Usage;
  artifacts: string[];
  artifact(basename: string): string; // absolute path; throws if absent
}

export interface GateResult {
  decision: Decision;
  note?: string;
  by: string;
}

export interface Run {
  readonly id: string;
  readonly params: Record<string, string>;
  readonly workspace: string;
  step(name: string, opts: StepOptions): Promise<StepResult>;
  gate(name: string, opts?: { show?: string[]; options?: string[] }): Promise<GateResult>;
  effect<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  abandon(reason?: string): Promise<never>;
  t(file: string): PromptSpec; // template relative to the loop file, then workspace
}

export type LoopFn = (run: Run) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers shared across core
// ---------------------------------------------------------------------------

export function stepKey(kind: "s" | "g" | "e", name: string, occ: number): string {
  return `${kind}:${name}.${occ}`;
}

export function parseDuration(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(v.trim());
  if (!m) throw new Error(`invalid duration: ${v}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return Math.round(n * mult);
}

// The ledger: append-only events.jsonl, single writer (enforced by lock.ts).
// Crash recovery rule (§5.1): a torn final line is truncated on open.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  SCHEMA_VERSION,
  type AnyEnvelope,
  type EventMap,
  type EventType,
  type GateRecord,
  type RunState,
  type StepRecord,
} from "./types.ts";

export const LEDGER_FILE = "events.jsonl";
export const STATE_FILE = "state.json";

export function ledgerPath(runDir: string): string {
  return path.join(runDir, LEDGER_FILE);
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Truncate a torn trailing line, if any. Returns the byte length kept. */
export function repairLedger(runDir: string): number {
  const p = ledgerPath(runDir);
  if (!fs.existsSync(p)) return 0;
  const buf = fs.readFileSync(p);
  if (buf.length === 0) return 0;
  const lastNl = buf.lastIndexOf(0x0a);
  let keep = lastNl + 1; // 0 if no newline at all
  // The final newline-terminated line must also parse; walk back if it doesn't.
  while (keep > 0) {
    const prevNl = buf.lastIndexOf(0x0a, keep - 2);
    const line = buf.subarray(prevNl + 1, keep - 1).toString("utf8");
    try {
      JSON.parse(line);
      break;
    } catch {
      keep = prevNl + 1;
    }
  }
  if (keep !== buf.length) fs.truncateSync(p, keep);
  return keep;
}

/** Read all events. Call repairLedger first when you may be the writer. */
export function readLedger(runDir: string): AnyEnvelope[] {
  const p = ledgerPath(runDir);
  if (!fs.existsSync(p)) return [];
  const out: AnyEnvelope[] = [];
  const text = fs.readFileSync(p, "utf8");
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    start = nl === -1 ? text.length : nl + 1;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AnyEnvelope);
    } catch {
      // Mid-file corruption is localized to the line (§5.1). Skip it.
      process.stderr.write(`etium: skipping unparseable ledger line in ${p}\n`);
    }
  }
  return out;
}

/** Single-writer append handle. Open only while holding the run lock. */
export class LedgerWriter {
  private fd: number;
  private seq: number;
  readonly run: string;
  readonly runDir: string;

  constructor(runDir: string, run: string, lastSeq: number) {
    this.runDir = runDir;
    this.run = run;
    this.seq = lastSeq;
    this.fd = fs.openSync(ledgerPath(runDir), "a");
  }

  append<T extends EventType>(type: T, data: EventMap[T]): AnyEnvelope {
    const env = {
      v: SCHEMA_VERSION,
      ts: new Date().toISOString(),
      run: this.run,
      seq: ++this.seq,
      type,
      data,
    } as AnyEnvelope;
    fs.writeSync(this.fd, JSON.stringify(env) + "\n");
    fs.fsyncSync(this.fd);
    return env;
  }

  get lastSeq(): number {
    return this.seq;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Fold: RunState is a pure function of the event list (§2 invariant 2)
// ---------------------------------------------------------------------------

export function fold(run: string, events: AnyEnvelope[]): RunState {
  const st: RunState = {
    run,
    seq: 0,
    steps: new Map<string, StepRecord>(),
    gates: new Map<string, GateRecord>(),
    effects: new Map(),
    usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    stepCount: 0,
    pendingNotes: [],
    status: "created",
  };
  for (const e of events) {
    st.seq = e.seq;
    st.lastEventTs = e.ts;
    switch (e.type) {
      case "run.created":
        st.created = e.data;
        break;
      case "supervisor.started":
        if (!st.completed) st.status = "running";
        break;
      case "step.started": {
        const k = `${e.data.name}.${e.data.occ}`;
        const rec = st.steps.get(k) ?? { name: e.data.name, occ: e.data.occ };
        rec.started = e.data;
        rec.startedSeq = e.seq;
        rec.completed = undefined; // a restart supersedes a prior attempt record
        st.steps.set(k, rec);
        st.stepCount += 1;
        if (e.data.notes) st.pendingNotes = [];
        break;
      }
      case "step.completed": {
        const k = `${e.data.step.name}.${e.data.step.occ}`;
        const rec =
          st.steps.get(k) ?? { name: e.data.step.name, occ: e.data.step.occ };
        rec.completed = e.data;
        st.steps.set(k, rec);
        const u = e.data.usage;
        if (u) {
          st.usage.tokensIn += u.tokensIn ?? 0;
          st.usage.tokensOut += u.tokensOut ?? 0;
          st.usage.costUsd += u.costUsd ?? 0;
        }
        break;
      }
      case "gate.opened": {
        const k = `${e.data.name}.${e.data.occ}`;
        const rec = st.gates.get(k) ?? { name: e.data.name, occ: e.data.occ };
        rec.opened = e.data;
        st.gates.set(k, rec);
        break;
      }
      case "gate.decided": {
        const k = `${e.data.name}.${e.data.occ}`;
        const rec = st.gates.get(k) ?? { name: e.data.name, occ: e.data.occ };
        rec.decided = e.data;
        st.gates.set(k, rec);
        if (e.data.note) st.pendingNotes.push(e.data.note);
        break;
      }
      case "effect.recorded":
        st.effects.set(`${e.data.name}.${e.data.occ}`, e.data);
        break;
      case "run.parked":
        if (!st.completed) st.status = "parked";
        break;
      case "run.interrupted":
        if (!st.completed) st.status = "interrupted";
        break;
      case "run.completed":
        st.completed = e.data;
        st.status = "completed";
        break;
      case "step.activity":
      case "budget.warning":
      case "budget.exceeded":
        break;
    }
  }
  return st;
}

export function openGates(st: RunState): GateRecord[] {
  return [...st.gates.values()].filter((g) => g.opened && !g.decided);
}

export function loadState(runDir: string): RunState {
  repairLedger(runDir);
  const run = path.basename(runDir);
  return fold(run, readLedger(runDir));
}

/** Derived cache for humans and cheap tooling; rebuildable via `etium rebuild`. */
export function writeStateCache(runDir: string, st: RunState): void {
  const json = {
    run: st.run,
    status: st.status,
    seq: st.seq,
    lastEventTs: st.lastEventTs,
    usage: st.usage,
    stepCount: st.stepCount,
    openGates: openGates(st).map((g) => ({ name: g.name, occ: g.occ })),
    steps: [...st.steps.values()].map((s) => ({
      name: s.name,
      occ: s.occ,
      status: s.completed?.status ?? (s.started ? "running" : "pending"),
      passed: s.completed?.passed,
    })),
    completed: st.completed,
  };
  const tmp = path.join(runDir, STATE_FILE + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n");
  fs.renameSync(tmp, path.join(runDir, STATE_FILE));
}

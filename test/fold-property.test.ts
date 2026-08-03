// DESIGN §12: "property tests on the fold (random valid event interleavings
// preserve invariants)". Seeded LCG so failures are reproducible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, openGates } from "../src/ledger.ts";
import { SCHEMA_VERSION, type AnyEnvelope, type EventMap, type EventType } from "../src/types.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function gen(seed: number): AnyEnvelope[] {
  const rnd = lcg(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  let seq = 0;
  const ev = <T extends EventType>(type: T, data: EventMap[T]): AnyEnvelope =>
    ({ v: SCHEMA_VERSION, ts: new Date(1700000000000 + seq * 1000).toISOString(), run: "r", seq: ++seq, type, data }) as AnyEnvelope;

  const out: AnyEnvelope[] = [
    ev("run.created", { taskSha256: "0".repeat(64), loop: "l", params: {}, workspace: "w", etiumVersion: "0" }),
    ev("supervisor.started", { pid: 1, host: "h" }),
  ];
  const runningSteps: Array<{ name: string; occ: number }> = [];
  const openGateRefs: Array<{ name: string; occ: number }> = [];
  let stepN = 0;
  let gateN = 0;

  const n = 5 + Math.floor(rnd() * 40);
  for (let i = 0; i < n; i++) {
    const roll = rnd();
    if (roll < 0.3) {
      const name = `s${stepN % 4}`;
      const occ = Math.floor(stepN / 4);
      stepN++;
      out.push(ev("step.started", { name, occ, harness: "exec", promptSha256: "0".repeat(64), envProfile: "agent", budget: {}, digest: "d" }));
      runningSteps.push({ name, occ });
    } else if (roll < 0.55 && runningSteps.length) {
      const s = runningSteps.shift()!;
      const metered = rnd() < 0.5;
      out.push(ev("step.completed", {
        step: s, status: pick(["ok", "error", "budget", "killed"]),
        exit: 0, signal: null, rawFile: "raw", rawSha256: "0".repeat(64), artifacts: [],
        usage: metered ? { tokensIn: 10, tokensOut: 5, costUsd: 0.01 } : undefined,
      }));
    } else if (roll < 0.7) {
      const name = `g${gateN}`;
      gateN++;
      out.push(ev("gate.opened", { name, occ: 0, options: ["approve", "reject"], show: [] }));
      openGateRefs.push({ name, occ: 0 });
    } else if (roll < 0.85 && openGateRefs.length) {
      const g = openGateRefs.shift()!;
      out.push(ev("gate.decided", { ...g, decision: pick(["approve", "reject"]), by: "x", via: "cli", note: rnd() < 0.3 ? "n" : undefined }));
    } else if (roll < 0.9) {
      out.push(ev("budget.warning", { kind: "stall", detail: "d" }));
    } else if (roll < 0.95 && openGateRefs.length && runningSteps.length === 0) {
      out.push(ev("run.parked", { gates: [...openGateRefs] }));
      out.push(ev("supervisor.started", { pid: 2, host: "h" })); // later re-attach
    } else {
      out.push(ev("run.interrupted", { reason: "stale-lock" }));
      out.push(ev("supervisor.started", { pid: 3, host: "h" }));
      // Interrupted mid-step: the step restarts with a fresh step.started.
      for (const s of [...runningSteps]) {
        out.push(ev("step.started", { name: s.name, occ: s.occ, harness: "exec", promptSha256: "0".repeat(64), envProfile: "agent", budget: {}, digest: "d" }));
      }
    }
  }
  if (rnd() < 0.6) out.push(ev("run.completed", { status: pick(["done", "abandoned", "error"]) }));
  return out;
}

test("fold invariants hold over randomized valid interleavings", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const events = gen(seed);
    const st = fold("r", events);
    const st2 = fold("r", events);
    const ctx = `seed=${seed}`;

    // Deterministic.
    assert.deepEqual(JSON.parse(JSON.stringify({ ...st, steps: [...st.steps], gates: [...st.gates], effects: [...st.effects] })),
      JSON.parse(JSON.stringify({ ...st2, steps: [...st2.steps], gates: [...st2.gates], effects: [...st2.effects] })), ctx);

    // seq tracks the last event.
    assert.equal(st.seq, events.at(-1)!.seq, ctx);

    // run.completed is terminal and authoritative for status.
    const completed = events.some((e) => e.type === "run.completed");
    assert.equal(st.status === "completed", completed, ctx);

    // Open gates are exactly opened-and-undecided.
    for (const g of openGates(st)) {
      assert.ok(g.opened && !g.decided, ctx);
    }
    const decidedCount = events.filter((e) => e.type === "gate.decided").length;
    const openedCount = events.filter((e) => e.type === "gate.opened").length;
    assert.equal(openGates(st).length, openedCount - decidedCount, ctx);

    // Usage equals the sum over step.completed events.
    const sum = events.reduce(
      (a, e) => {
        if (e.type === "step.completed" && e.data.usage) {
          a.tokensIn += e.data.usage.tokensIn ?? 0;
          a.tokensOut += e.data.usage.tokensOut ?? 0;
          a.costUsd += e.data.usage.costUsd ?? 0;
        }
        return a;
      },
      { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    );
    assert.deepEqual(st.usage, sum, ctx);

    // stepCount counts every step.started (the per-run guard's basis).
    assert.equal(st.stepCount, events.filter((e) => e.type === "step.started").length, ctx);

    // A restarted step (step.started after its completion cleared) never keeps
    // a stale completed record unless a completion followed the restart.
    for (const [k, rec] of st.steps) {
      if (rec.completed) {
        const lastStart = events.findLast((e) => e.type === "step.started" && `${e.data.name}.${e.data.occ}` === k)!;
        const lastDone = events.findLast((e) => e.type === "step.completed" && `${e.data.step.name}.${e.data.step.occ}` === k)!;
        assert.ok(lastDone.seq > lastStart.seq, ctx);
      }
    }
  }
});

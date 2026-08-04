// The ai-engineer loop is CLI-complete and surface-agnostic: this drives the
// FULL state graph — triage → route → design (with a revise round) → plan →
// implement (with check) → wrap-up, plus the stuck/accept path — using only
// scripted exec steps (`cmd.*` dry-run hooks) and mailbox decisions. No
// GitHub, no model, no surface. The GitHub surface is a skin over exactly
// these gates.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger } from "../src/ledger.ts";
import { writeDecision } from "../src/lock.ts";
import { createRun } from "../src/supervisor.ts";
import { tickOnce } from "../src/tick.ts";

const LOOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ai-engineer", "loop.ts");
const APPROVE = `printf 'VERDICT: approve\\n' > ai/REVIEW.md`;
const ROUTE_STAGES = ["debug", "design", "plan", "implement"];

function lastOpenGate(runDir: string): { name: string; occ: number; options: string[] } {
  const decided = new Set(
    readLedger(runDir)
      .filter((e) => e.type === "gate.decided")
      .map((e) => `${(e.data as { name: string }).name}.${(e.data as { occ: number }).occ}`),
  );
  const open = readLedger(runDir)
    .filter((e) => e.type === "gate.opened")
    .map((e) => e.data as { name: string; occ: number; options: string[] })
    .filter((g) => !decided.has(`${g.name}.${g.occ}`));
  assert.equal(open.length, 1, "expected exactly one open gate");
  return open[0]!;
}

async function decide(base: string, runDir: string, gate: { name: string; occ: number }, decision: string, note?: string) {
  writeDecision(runDir, { name: gate.name, occ: gate.occ, decision, note, by: "operator", via: "cli", ts: new Date().toISOString() });
  await tickOnce(base, "unused-entry", true);
}

test("full graph: triage → design (revise round) → plan → implement+check → wrap-up", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "Fix the flaky auth test in ci/",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "2",
      check: "test -f fixed.txt",
      "cmd.design": "mkdir -p ai && printf 'approach A\\n' > ai/DESIGN.md",
      "cmd.design-review": `if [ -f ai/.dr ]; then ${APPROVE}; else printf 'VERDICT: revise\\ndesign-scope: too broad\\n' > ai/REVIEW.md && touch ai/.dr; fi`,
      "cmd.plan": "printf '1. fix retry\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
      "cmd.implement": "printf 'done\\n' > ai/REPORT.md && touch fixed.txt",
      "cmd.implement-review": APPROVE,
    },
  });

  await tickOnce(base, "unused-entry", true);
  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.deepEqual(gate.options, ["debug", "design", "plan", "consider"]); // no implement yet: fail-closed routing

  await decide(base, runDir, gate, "design"); // revise round then approve: design.0, design-review.0, design.1, design-review.1
  const designSteps = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .map((e) => (e.data as { name: string; occ: number }))
    .filter((s) => s.name === "design");
  assert.equal(designSteps.length, 2, "reviser forced a second builder round");

  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "consider"]); // design done ≠ plan done

  await decide(base, runDir, gate, "plan");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "implement", "consider"]); // plan unlocks implement

  await decide(base, runDir, gate, "implement");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "implement", "wrap-up", "consider"]);
  assert.ok(fs.existsSync(path.join(runDir, "ws", "fixed.txt")), "check gated on real workspace evidence");

  await decide(base, runDir, gate, "wrap-up");
  const last = readLedger(runDir).at(-1)!;
  assert.equal(last.type, "run.completed");
  assert.deepEqual((last.data as { status: string }).status, "done");
});

test("stuck path: reviewer never approves → <stage>-stuck gate → accept proceeds", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "diagnose it",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      "cmd.debug": "mkdir -p ai && printf 'cause: unknown\\n' > ai/DIAGNOSIS.md",
      "cmd.debug-review": `printf 'VERDICT: revise\\ndebug-evidence: none\\n' > ai/REVIEW.md`,
    },
  });
  await tickOnce(base, "unused-entry", true);
  await decide(base, runDir, lastOpenGate(runDir), "debug");

  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "debug-stuck");
  assert.deepEqual(gate.options, ["keep-going", "accept", "wrap-up", "consider"]);
  const opened0 = readLedger(runDir)
    .filter((e) => e.type === "gate.opened")
    .map((e) => e.data as { name: string; occ: number; show: string[]; reason?: string })
    .find((g) => g.name === "debug-stuck" && g.occ === 0)!;
  assert.match(opened0.reason!, /debug reviewer still objects/, "escalations carry their why (ADR-028)");
  assert.equal(opened0.show[0], "ai/REVIEW.md", "the reviewer's blockers lead the shown files");

  await decide(base, runDir, gate, "keep-going"); // one more round, still revising → stuck.1
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "debug-stuck");
  assert.equal(gate.occ, 1);

  await decide(base, runDir, gate, "accept"); // proceed despite objections
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");

  await decide(base, runDir, gate, "wrap-up"); // wait — wrap-up not offered before implement
  // The decision above is dropped fail-closed (not in options); run stays parked.
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(!gate.options.includes("wrap-up"));
});

test("kickoff directive: an exact route word goes straight to the stage — no interpreter, no gate", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "the retry helper drops the last attempt",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "plan",
      "cmd.plan": "mkdir -p ai && printf '1. fix retry\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);

  const gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(gate.options.includes("implement"), "plan converged before any gate opened");
  const evts = readLedger(runDir);
  assert.ok(!evts.some((e) => e.type === "step.started" && (e.data as { name: string }).name === "interpret"),
    "an exact word is taken literally — no model consulted");
  const planAt = evts.findIndex((e) => e.type === "step.started" && (e.data as { name: string }).name === "plan");
  const gateAt = evts.findIndex((e) => e.type === "gate.opened");
  assert.ok(planAt >= 0 && planAt < gateAt, "the stage ran before the first gate");
});

test("kickoff directive: freestyle is interpreted, then the stage runs without a gate; unclear parks showing the question", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "make it faster",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "come up with a plan for this",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: plan\\n' > ai/REPLY.md",
      "cmd.plan": "printf '1. speed\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  const gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(gate.options.includes("implement"), "interpreted route converged before any gate");

  // Unclear directive: nothing runs; the route gate opens showing the question.
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir: runDir2 } = createRun(base2, {
    task: "make it faster",
    loop: LOOP,
    params: {
      harness: "exec",
      directive: "hmm you know the thing",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: unclear\\nDebug, design, or plan?\\n' > ai/REPLY.md",
    },
  });
  await tickOnce(base2, "unused-entry", true);
  const opened = readLedger(runDir2)
    .filter((e) => e.type === "gate.opened")
    .map((e) => e.data as { name: string; show?: string[]; options: string[] });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.name, "route");
  assert.deepEqual(opened[0]!.show, ["ai/REPLY.md"]);
  assert.ok(!readLedger(runDir2).some((e) => e.type === "step.started" && ROUTE_STAGES.includes((e.data as { name: string }).name)),
    "no stage ran on an unclear directive — fail closed");
});

test("per-step harness: harness.<step> overrides the loop-wide value (ADR-025)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "route me",
    loop: LOOP,
    params: {
      harness: "not-a-real-harness", // would fail the pre-spawn gate if any step used it
      "harness.interpret": "exec",
      directive: "please sort this out somehow",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: unclear\\nWhich stage?\\n' > ai/REPLY.md",
    },
  });
  await tickOnce(base, "unused-entry", true);
  const started = readLedger(runDir).find((e) => e.type === "step.started" && (e.data as { name: string }).name === "interpret")!;
  assert.equal((started.data as { harness: string }).harness, "exec", "per-step harness recorded in the ledger");
  const done = readLedger(runDir).find((e) => e.type === "step.completed" && (e.data as { step: { name: string } }).step.name === "interpret")!;
  assert.equal((done.data as { status: string }).status, "ok", "interpret ran under its own harness");
  assert.equal(lastOpenGate(runDir).name, "route", "run parked healthy — the bogus loop-wide harness was never touched");
});

test("consider: the interpreter maps freestyle to an option; unclear re-asks showing the question", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "tidy the parser",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      "cmd.interpret": `mkdir -p ai; if [ -f ai/.i ]; then printf 'ACTION: plan\\n' > ai/REPLY.md; else printf 'ACTION: unclear\\nWhich stage did you mean?\\n' > ai/REPLY.md && touch ai/.i; fi`,
      "cmd.plan": "printf '1. tidy\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");

  await decide(base, runDir, gate, "consider", "please do the planning thing");
  // First interpretation came back unclear → the same gate re-opens with the question shown.
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.equal(gate.occ, 1);
  const reopened = readLedger(runDir)
    .filter((e) => e.type === "gate.opened")
    .map((e) => e.data as { name: string; occ: number; show?: string[] })
    .find((g) => g.name === "route" && g.occ === 1)!;
  assert.deepEqual(reopened.show, ["ai/REPLY.md"]);

  await decide(base, runDir, gate, "consider", "make the plan");
  // Second interpretation resolved to plan → the stage converged, implement unlocked.
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.equal(gate.occ, 2);
  assert.ok(gate.options.includes("implement"));
  const interprets = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .filter((e) => (e.data as { name: string }).name === "interpret");
  assert.equal(interprets.length, 2);
});

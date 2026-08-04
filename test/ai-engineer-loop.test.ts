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
      "cmd.triage": "mkdir -p ai && printf 'recommend: design\\n' > ai/INTAKE.md",
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
  assert.deepEqual(gate.options, ["triage", "debug", "design", "plan", "consider"]); // no implement yet: fail-closed routing

  await decide(base, runDir, gate, "design"); // revise round then approve: design.0, design-review.0, design.1, design-review.1
  const designSteps = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .map((e) => (e.data as { name: string; occ: number }))
    .filter((s) => s.name === "design");
  assert.equal(designSteps.length, 2, "reviser forced a second builder round");

  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["triage", "debug", "design", "plan", "consider"]); // design done ≠ plan done

  await decide(base, runDir, gate, "plan");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["triage", "debug", "design", "plan", "implement", "consider"]); // plan unlocks implement

  await decide(base, runDir, gate, "implement");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["triage", "debug", "design", "plan", "implement", "wrap-up", "consider"]);
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
      "cmd.triage": "mkdir -p ai && printf 'recommend: debug\\n' > ai/INTAKE.md",
      "cmd.debug": "printf 'cause: unknown\\n' > ai/DIAGNOSIS.md",
      "cmd.debug-review": `printf 'VERDICT: revise\\ndebug-evidence: none\\n' > ai/REVIEW.md`,
    },
  });
  await tickOnce(base, "unused-entry", true);
  await decide(base, runDir, lastOpenGate(runDir), "debug");

  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "debug-stuck");
  assert.deepEqual(gate.options, ["keep-going", "accept", "wrap-up", "consider"]);

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

test("kickoff directive: triage's route is followed without asking the gate (ADR-023)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "the retry helper drops the last attempt",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "fix this",
      "cmd.triage": `mkdir -p ai && printf '## Route\\nplan — the path is clear\\n' > ai/INTAKE.md`,
      "cmd.plan": "printf '1. fix retry\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);

  const gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(gate.options.includes("implement"), "plan converged before any gate opened");
  const evts = readLedger(runDir);
  const planAt = evts.findIndex((e) => e.type === "step.started" && (e.data as { name: string }).name === "plan");
  const gateAt = evts.findIndex((e) => e.type === "gate.opened");
  assert.ok(planAt >= 0 && planAt < gateAt, "auto-route ran the stage before the first gate");
});

test("per-step harness: harness.<step> overrides the loop-wide value (ADR-025)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "route me",
    loop: LOOP,
    params: {
      harness: "not-a-real-harness", // would fail the pre-spawn gate if any step used it
      "harness.triage": "exec",
      "cmd.triage": "mkdir -p ai && printf 'recommend: plan\\n' > ai/INTAKE.md",
    },
  });
  await tickOnce(base, "unused-entry", true);
  const started = readLedger(runDir).find((e) => e.type === "step.started" && (e.data as { name: string }).name === "triage")!;
  assert.equal((started.data as { harness: string }).harness, "exec", "per-step harness recorded in the ledger");
  const done = readLedger(runDir).find((e) => e.type === "step.completed" && (e.data as { step: { name: string } }).step.name === "triage")!;
  assert.equal((done.data as { status: string }).status, "ok", "triage ran under its own harness");
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
      "cmd.triage": "mkdir -p ai && printf 'recommend: plan\\n' > ai/INTAKE.md",
      "cmd.interpret": `if [ -f ai/.i ]; then printf 'ACTION: plan\\n' > ai/REPLY.md; else printf 'ACTION: unclear\\nWhich stage did you mean?\\n' > ai/REPLY.md && touch ai/.i; fi`,
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

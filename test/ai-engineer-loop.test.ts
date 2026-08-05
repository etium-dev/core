// The ai-engineer loop is CLI-complete and surface-agnostic: this drives the
// FULL state graph — route → design (with a revise round) → plan →
// implement (with check) → finalize, plus the stuck/accept path — using only
// scripted exec steps (`cmd.*` dry-run hooks) and mailbox decisions. No
// GitHub, no model, no surface. The GitHub surface is a skin over exactly
// these gates.

import { test } from "node:test";
import { spawnSync } from "node:child_process";
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

test("full graph: design (revise round) → plan → implement+check → finalize retires ai/ into a distilled commit", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "Fix the flaky auth test in ci/",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "2",
      check: "test -f fixed.txt",
      "cmd.design": "mkdir -p ai && printf 'SUMMARY: approach A\\n' > ai/DESIGN.md",
      "cmd.design-review": `if [ -f ai/.dr ]; then ${APPROVE}; else printf 'VERDICT: revise\\ndesign-scope: too broad\\n' > ai/REVIEW.md && touch ai/.dr; fi`,
      "cmd.plan": "printf '1. fix retry\\n' > ai/PLAN.md",
      "cmd.plan-review": APPROVE,
      "cmd.implement": "printf 'done\\n' > ai/REPORT.md && touch fixed.txt",
      "cmd.implement-review": APPROVE,
    },
  });

  const ws = path.join(runDir, "ws");
  spawnSync("git", ["-C", ws, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", ws, "config", "user.name", "t"]);
  spawnSync("git", ["-C", ws, "config", "user.email", "t@t"]);
  await tickOnce(base, "unused-entry", true);
  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.deepEqual(gate.options, ["debug", "design", "consider"]); // no plan yet: every stage is earned

  await decide(base, runDir, gate, "design"); // revise round then approve: design.0, design-review.0, design.1, design-review.1
  const designSteps = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .map((e) => (e.data as { name: string; occ: number }))
    .filter((s) => s.name === "design");
  assert.equal(designSteps.length, 2, "reviser forced a second builder round");

  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "consider"]); // design converged → plan unlocked (nothing more)

  await decide(base, runDir, gate, "plan");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "implement", "consider"]); // plan unlocks implement

  await decide(base, runDir, gate, "implement");
  gate = lastOpenGate(runDir);
  assert.deepEqual(gate.options, ["debug", "design", "plan", "implement", "finalize", "consider"]);
  assert.ok(fs.existsSync(path.join(runDir, "ws", "fixed.txt")), "check gated on real workspace evidence");
  const opened = readLedger(runDir).filter((e) => e.type === "gate.opened").at(-1)!.data as { reason?: string };
  assert.match(opened.reason!, /review the draft PR.*finalize/, "the post-implement gate teaches the ending");

  await decide(base, runDir, gate, "finalize");
  const last = readLedger(runDir).at(-1)!;
  assert.equal(last.type, "run.completed");
  assert.deepEqual((last.data as { status: string }).status, "done");
  // The one closing ceremony: ai/ retired from the tip, history intact,
  // SUMMARY lines distilled into the final commit message.
  assert.ok(!fs.existsSync(path.join(ws, "ai")), "ai/ retired from the tip");
  const msg = spawnSync("git", ["-C", ws, "log", "-1", "--format=%B"], { encoding: "utf8" }).stdout;
  assert.match(msg, /^ai: finalize/);
  assert.match(msg, /Design: approach A/);
  assert.match(msg, /Verified: test -f fixed\.txt/);
  const shas = readLedger(runDir).filter((e) => e.type === "effect.recorded" && (e.data as { name: string }).name === "sha");
  assert.ok(shas.length >= 1, "every commit records its sha for version-pinned links (ADR-032)");
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
  assert.deepEqual(gate.options, ["keep-going", "accept", "consider"]); // ending is /et stop, not a stage verdict
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

  await decide(base, runDir, gate, "finalize"); // not offered before implement converges
  // The decision above is dropped fail-closed (not in options); run stays parked.
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(!gate.options.includes("finalize"));
});

test("kickoff directive: an exact route word goes straight to the stage — no interpreter, no gate", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "the retry helper drops the last attempt",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "design",
      "cmd.design": "mkdir -p ai && printf 'mini: reword and validate\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);

  const gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(gate.options.includes("plan"), "design converged before any gate opened — plan unlocked");
  const evts = readLedger(runDir);
  assert.ok(!evts.some((e) => e.type === "step.started" && (e.data as { name: string }).name === "interpret"),
    "an exact word is taken literally — no model consulted");
  const designAt = evts.findIndex((e) => e.type === "step.started" && (e.data as { name: string }).name === "design");
  const gateAt = evts.findIndex((e) => e.type === "gate.opened");
  assert.ok(designAt >= 0 && designAt < gateAt, "the stage ran before the first gate");
});

test("kickoff directive: freestyle is interpreted, then the stage runs without a gate; unclear parks showing the question", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "make it faster",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "come up with a design for this",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: design\\n' > ai/REPLY.md",
      "cmd.design": "printf 'mini: cache the result\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  const gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.ok(gate.options.includes("plan"), "interpreted route converged before any gate — plan unlocked");

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

test("operator words reach both personas for the whole stage (ADR-033)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "steer me",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      "cmd.design": "mkdir -p ai && printf 'SUMMARY: d\\n' > ai/DESIGN.md",
      "cmd.design-review": "printf 'VERDICT: revise\\ndesign-x: no\\n' > ai/REVIEW.md",
    },
  });
  await tickOnce(base, "unused-entry", true);
  await decide(base, runDir, lastOpenGate(runDir), "design", "entry-instruction");
  // Round 0 ran with the entry note; reviewer objects → design-stuck.
  assert.equal(lastOpenGate(runDir).name, "design-stuck");
  // Mid-stage, the operator speaks with no gate to receive it: mailbox.
  fs.mkdirSync(path.join(runDir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "notes", "github-901.json"),
    JSON.stringify({ ts: new Date().toISOString(), by: "carlos", text: "mid-stage-instruction" }));
  await decide(base, runDir, lastOpenGate(runDir), "keep-going", "standing-ruling");

  const steps = fs.readdirSync(path.join(runDir, "steps"));
  const promptOf = (suffix: string) => {
    const d = steps.find((n) => n.endsWith(suffix))!;
    assert.ok(d, `no step dir for ${suffix}`);
    return fs.readFileSync(path.join(runDir, "steps", d, "prompt.md"), "utf8");
  };
  for (const suffix of ["design.1", "design-review.1"]) {
    const prompt = promptOf(suffix);
    assert.ok(prompt.includes("<operator_instructions>"), `${suffix} missing the block`);
    assert.ok(prompt.includes("entry-instruction"), `${suffix} missing the entry note`);
    assert.ok(prompt.includes("standing-ruling"), `${suffix} missing the keep-going ruling`);
    assert.ok(prompt.includes("carlos: mid-stage-instruction"), `${suffix} missing the mailbox note`);
    assert.ok(prompt.includes("outrank repository documentation"), `${suffix} missing the authority phrasing`);
  }
  // The reviewer round BEFORE the ruling saw only the entry note.
  assert.ok(!promptOf("design-review.0").includes("standing-ruling"));
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
      "cmd.interpret": `mkdir -p ai; if [ -f ai/.i ]; then printf 'ACTION: design\\n' > ai/REPLY.md; else printf 'ACTION: unclear\\nWhich stage did you mean?\\n' > ai/REPLY.md && touch ai/.i; fi`,
      "cmd.design": "printf 'mini: tidy\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
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

  await decide(base, runDir, gate, "consider", "make the design");
  // Second interpretation resolved to design → the stage converged, plan unlocked.
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route");
  assert.equal(gate.occ, 2);
  assert.ok(gate.options.includes("plan"));
  const interprets = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .filter((e) => (e.data as { name: string }).name === "interpret");
  assert.equal(interprets.length, 2);
});

test("mode: a named mode overlays every later step (ADR-037)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "tidy the retry helper",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "go deep on this one",
      modes: JSON.stringify({ deep: { describe: "careful — fable designs", params: { "model.design": "fable" } } }),
      "cmd.mode": "mkdir -p ai && printf 'MODE: deep\\n' > ai/REPLY.md",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: design\\n' > ai/REPLY.md",
      "cmd.design": "printf 'mini: reword\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  const started = readLedger(runDir)
    .filter((e) => e.type === "step.started")
    .map((e) => e.data as { name: string; model?: string });
  assert.ok(started.some((s) => s.name === "mode"), "the mode interpreter ran on the operator's words");
  assert.equal(started.find((s) => s.name === "design")!.model, "fable", "deep mode overlaid model.design");
});

test("mode: clearly meant but unmatched parks a fail-closed gate to pick or rephrase (ADR-037)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "make it faster",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "use turbo mode",
      modes: JSON.stringify({ deep: { describe: "careful" }, fast: { describe: "cheap", params: { "model.design": "codex" } } }),
      "cmd.mode": "mkdir -p ai && printf 'MODE: unclear\\ndeep or fast?\\n' > ai/REPLY.md",
      "cmd.interpret": "mkdir -p ai && printf 'ACTION: design\\n' > ai/REPLY.md",
      "cmd.design": "printf 'mini: x\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  let gate = lastOpenGate(runDir);
  assert.equal(gate.name, "mode", "an unmatched mode request parks — never a silent default");
  assert.deepEqual(gate.options, ["deep", "fast", "default", "consider"]);
  const opened = readLedger(runDir)
    .filter((e) => e.type === "gate.opened")
    .map((e) => e.data as { name: string; show: string[]; reason?: string })
    .find((g) => g.name === "mode")!;
  assert.match(opened.reason!, /couldn't match/, "the gate says why and lists the modes");
  assert.deepEqual(opened.show, ["ai/REPLY.md"]);

  await decide(base, runDir, gate, "fast"); // pick one → overlay applies, run proceeds
  gate = lastOpenGate(runDir);
  assert.equal(gate.name, "route", "resolving the mode unblocks routing");
  assert.equal(
    readLedger(runDir).filter((e) => e.type === "step.started").map((e) => e.data as { name: string; model?: string })
      .find((s) => s.name === "design")!.model,
    "codex",
    "the mode chosen at the gate overlaid the design step",
  );
});

test("mode: no catalog configured → the mode interpreter never runs (unchanged behavior)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ai-"));
  const { runDir } = createRun(base, {
    task: "x",
    loop: LOOP,
    params: {
      harness: "exec",
      rounds: "1",
      directive: "design",
      "cmd.design": "mkdir -p ai && printf 'mini: y\\n' > ai/DESIGN.md",
      "cmd.design-review": APPROVE,
    },
  });
  await tickOnce(base, "unused-entry", true);
  assert.ok(
    !readLedger(runDir).some((e) => e.type === "step.started" && (e.data as { name: string }).name === "mode"),
    "no modes in config → not one mode step spawns",
  );
});

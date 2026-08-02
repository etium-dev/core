import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LedgerWriter, loadState, readLedger } from "../src/ledger.ts";
import { executeLoop, type RunStepImpl } from "../src/engine.ts";
import { writeDecision } from "../src/lock.ts";
import type { LoopFn } from "../src/types.ts";

function tmpRun(): { runDir: string; workspace: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-test-"));
  const runDir = path.join(base, "runs", "r1");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { runDir, workspace };
}

function fakeStepImpl(calls: string[]): RunStepImpl {
  return async (a) => {
    calls.push(`${a.name}.${a.occ}`);
    a.emitActivity("lifecycle", "started", undefined, 1);
    return {
      status: "ok",
      exit: 0,
      rawFile: "steps/x/raw.jsonl",
      rawSha256: "0".repeat(64),
      artifacts: [],
      passed: true,
    };
  };
}

async function exec(runDir: string, workspace: string, loopFn: LoopFn, impl: RunStepImpl) {
  const state = loadState(runDir);
  const writer = new LedgerWriter(runDir, "r1", state.seq);
  try {
    return await executeLoop({
      runDir,
      runId: "r1",
      writer,
      state,
      loopFn,
      loopDir: workspace,
      params: {},
      workspace,
      preapprovals: [],
      runStepImpl: impl,
      pollMs: 5,
    });
  } finally {
    writer.close();
  }
}

test("memoization: completed steps do not re-execute on replay", async () => {
  const { runDir, workspace } = tmpRun();
  const loop: LoopFn = async (run) => {
    await run.step("a", { harness: "exec", command: "true" });
    await run.step("b", { harness: "exec", command: "true" });
  };
  const calls1: string[] = [];
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl(calls1)), "done");
  assert.deepEqual(calls1, ["a.0", "b.0"]);

  const calls2: string[] = [];
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl(calls2)), "done");
  assert.deepEqual(calls2, []); // everything replayed from the ledger
  const done = readLedger(runDir).filter((e) => e.type === "run.completed");
  assert.equal(done.length, 2);
  assert.equal((done[1]!.data as { orphans?: string[] }).orphans, undefined);
});

test("occurrence keys: same step name twice gets occ 0 and 1", async () => {
  const { runDir, workspace } = tmpRun();
  const loop: LoopFn = async (run) => {
    await run.step("x", { harness: "exec", command: "true" });
    await run.step("x", { harness: "exec", command: "true" });
  };
  const calls: string[] = [];
  await exec(runDir, workspace, loop, fakeStepImpl(calls));
  assert.deepEqual(calls, ["x.0", "x.1"]);
});

test("divergence: changed step config fails loudly, never silently re-runs", async () => {
  const { runDir, workspace } = tmpRun();
  const v1: LoopFn = async (run) => {
    await run.step("a", { harness: "exec", command: "one" });
  };
  const v2: LoopFn = async (run) => {
    await run.step("a", { harness: "exec", command: "two" });
  };
  await exec(runDir, workspace, v1, fakeStepImpl([]));
  const calls: string[] = [];
  assert.equal(await exec(runDir, workspace, v2, fakeStepImpl(calls)), "error");
  assert.deepEqual(calls, []);
  const last = readLedger(runDir).at(-1)!;
  assert.equal(last.type, "run.completed");
  assert.match((last.data as { summary: string }).summary, /^DIVERGENCE/);
});

test("effects: recorded once, replayed thereafter", async () => {
  const { runDir, workspace } = tmpRun();
  let fnCalls = 0;
  const loop: LoopFn = async (run) => {
    const v = await run.effect("rand", async () => {
      fnCalls++;
      return { n: Math.random() };
    });
    if (typeof (v as { n: number }).n !== "number") throw new Error("bad effect value");
  };
  await exec(runDir, workspace, loop, fakeStepImpl([]));
  await exec(runDir, workspace, loop, fakeStepImpl([]));
  assert.equal(fnCalls, 1);
});

test("parking: gate with no decision parks; mailbox decision resumes; note injected", async () => {
  const { runDir, workspace } = tmpRun();
  const prompts: string[] = [];
  const impl: RunStepImpl = async (a) => {
    prompts.push(`${a.name}:${a.prompt}`);
    return { status: "ok", exit: 0, rawFile: "r", rawSha256: "0".repeat(64), artifacts: [], passed: true };
  };
  const loop: LoopFn = async (run) => {
    await run.step("before", { harness: "exec", command: "true" });
    const d = await run.gate("plan-approved", { show: ["PLAN.md"] });
    await run.step("after", { harness: "exec", prompt: `decision was ${d.decision}` });
  };
  assert.equal(await exec(runDir, workspace, loop, impl), "parked");
  const types = readLedger(runDir).map((e) => e.type);
  assert.ok(types.includes("gate.opened"));
  assert.equal(types.at(-1), "run.parked");

  writeDecision(runDir, {
    name: "plan-approved",
    occ: 0,
    decision: "approve",
    note: "skip the retry refactor",
    by: "tester",
    via: "cli",
    ts: new Date().toISOString(),
  });
  assert.equal(await exec(runDir, workspace, loop, impl), "done");
  const after = prompts.find((p) => p.startsWith("after:"))!;
  assert.match(after, /decision was approve/);
  assert.match(after, /Operator notes:\n- skip the retry refactor/);
  assert.equal(fs.readdirSync(path.join(runDir, "decisions")).length, 0); // consumed once
});

test("abandon: run.completed with status abandoned", async () => {
  const { runDir, workspace } = tmpRun();
  const loop: LoopFn = async (run) => {
    await run.abandon("not worth it");
  };
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl([])), "abandoned");
  const last = readLedger(runDir).at(-1)!;
  assert.deepEqual(last.data, { status: "abandoned", summary: "not worth it" });
});

test("foreign await guard: a never-resolving non-etium promise errors out", async () => {
  const { runDir, workspace } = tmpRun();
  const loop: LoopFn = async () => {
    await new Promise(() => {});
  };
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl([])), "error");
  const last = readLedger(runDir).at(-1)!;
  assert.match((last.data as { summary: string }).summary, /non-etium promise/);
});

test("divergence: editing a template mid-run fails loudly", async () => {
  const { runDir, workspace } = tmpRun();
  fs.writeFileSync(path.join(workspace, "P.md"), "version one");
  const loop: LoopFn = async (run) => {
    await run.step("a", { harness: "exec", prompt: run.t("P.md") });
    await run.gate("hold"); // parks so we can edit between attaches
  };
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl([])), "parked");
  fs.writeFileSync(path.join(workspace, "P.md"), "version two");
  const calls: string[] = [];
  assert.equal(await exec(runDir, workspace, loop, fakeStepImpl(calls)), "error");
  assert.deepEqual(calls, []);
  assert.match(
    (readLedger(runDir).at(-1)!.data as { summary: string }).summary,
    /^DIVERGENCE/,
  );
});

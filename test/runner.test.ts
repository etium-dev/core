import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { runStep } from "../src/runner.ts";
import type { RunStepArgs } from "../src/engine.ts";
import type { StepOptions } from "../src/types.ts";

function scaffold() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-runner-"));
  const runDir = path.join(base, "run");
  const stepDir = path.join(runDir, "steps", "001-t.0");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(stepDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { runDir, stepDir, workspace };
}

function args(
  opts: StepOptions,
  extra?: Partial<RunStepArgs>,
): RunStepArgs & { activity: Array<{ kind: string; summary: string }>; warnings: string[] } {
  const s = scaffold();
  const activity: Array<{ kind: string; summary: string }> = [];
  const warnings: string[] = [];
  return {
    runDir: s.runDir,
    stepDir: s.stepDir,
    name: "t",
    occ: 0,
    opts,
    prompt: "",
    workspace: s.workspace,
    emitActivity: (kind, summary) => activity.push({ kind, summary }),
    emitWarning: (_k, detail) => warnings.push(detail),
    activity,
    warnings,
    ...extra,
  };
}

function readRaw(a: RunStepArgs, rawFile: string): string {
  const p = path.join(a.runDir, rawFile);
  if (p.endsWith(".zst")) {
    return execSync(`zstd -d -c ${JSON.stringify(p)}`).toString("utf8");
  }
  return fs.readFileSync(p, "utf8");
}

test("exec: raw captured, exit 0 => ok + passed", async () => {
  const a = args({ harness: "exec", command: "echo hello; echo world" });
  const r = await runStep(a);
  assert.equal(r.status, "ok");
  assert.equal(r.passed, true);
  assert.equal(readRaw(a, r.rawFile), "hello\nworld\n");
  assert.match(r.rawFile, /raw\.jsonl(\.zst)?$/);
});

test("exec: nonzero exit => error + not passed", async () => {
  const a = args({ harness: "exec", command: "exit 3" });
  const r = await runStep(a);
  assert.equal(r.status, "error");
  assert.equal(r.exit, 3);
  assert.equal(r.passed, false);
});

test("wall budget kills the whole process tree", async () => {
  const a = args({
    harness: "exec",
    command: "sh -c 'sleep 30' & sleep 30", // child in its own subshell too
    budget: { wall: 300 },
  });
  const t0 = Date.now();
  const r = await runStep(a);
  assert.equal(r.status, "budget");
  assert.equal(r.budgetHit, "wall");
  assert.ok(Date.now() - t0 < 5000, "kill was prompt");
});

test("stall warning fires without killing", async () => {
  const a = args({
    harness: "exec",
    command: "sleep 0.5; echo done",
    budget: { stallWarn: 120 },
  });
  const r = await runStep(a);
  assert.equal(r.status, "ok");
  assert.ok(a.warnings.length >= 1, `expected stall warnings, got ${a.warnings.length}`);
});

test("grade: failing grader => passed false, stdout captured as artifact", async () => {
  const a = args({
    harness: "exec",
    command: "echo build ok",
    grade: "echo the-grade-report; exit 1",
  });
  const r = await runStep(a);
  assert.equal(r.status, "ok");
  assert.equal(r.passed, false);
  const grade = r.artifacts.find((p) => p.endsWith("grade.txt"))!;
  assert.match(fs.readFileSync(path.join(a.runDir, grade), "utf8"), /the-grade-report/);
});

test("artifacts: exact path and glob collected from workspace", async () => {
  const a = args({ harness: "exec", command: "echo p > PLAN.md; mkdir -p r; echo x > r/a.md; echo y > r/b.txt", artifacts: ["PLAN.md", "r/*.md"] });
  const r = await runStep(a);
  const names = r.artifacts.map((p) => path.basename(p)).sort();
  assert.deepEqual(names, ["PLAN.md", "a.md"]);
});

test("redaction: secret env values never reach raw", async () => {
  const a = args({
    harness: "exec",
    command: 'echo "the token is $MY_API_TOKEN end"',
    env: { add: { MY_API_TOKEN: "sk-supersecret123" } },
  });
  const r = await runStep(a);
  const raw = readRaw(a, r.rawFile);
  assert.ok(!raw.includes("sk-supersecret123"));
  assert.match(raw, /the token is \[redacted\] end/);
});

test("replay through codex parser: activity + usage + token budget enforcement", async () => {
  const a1 = args({ harness: "replay", inner: "codex", fixture: "fx.jsonl" });
  const fixture = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({ type: "item.completed", item: { item_type: "agent_message", text: "I will fix the test" } }),
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "npm test" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 900, output_tokens: 200 } }),
    "not json at all",
  ].join("\n");
  fs.writeFileSync(path.join(a1.workspace, "fx.jsonl"), fixture);
  const r1 = await runStep(a1);
  assert.equal(r1.status, "ok");
  assert.deepEqual(r1.usage, { tokensIn: 900, tokensOut: 200, costUsd: 0 });
  const kinds = a1.activity.map((x) => x.kind);
  assert.ok(kinds.includes("message") && kinds.includes("tool") && kinds.includes("usage"));

  const a2 = args({ harness: "replay", inner: "codex", fixture: "fx.jsonl", budget: { tokens: 500 } });
  fs.writeFileSync(path.join(a2.workspace, "fx.jsonl"), fixture);
  const r2 = await runStep(a2);
  assert.equal(r2.status, "budget");
  assert.equal(r2.budgetHit, "tokens");
});

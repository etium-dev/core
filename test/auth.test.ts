// Model auth (ADR-007): declared passthrough, redaction-by-declaration, the
// pre-spawn gate, and retry-after-fix via resume.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { checkHarnessAuth, resolveEnv, runStep } from "../src/runner.ts";
import { getAdapter } from "../src/adapters.ts";
import { LedgerWriter, loadState, readLedger } from "../src/ledger.ts";
import { executeLoop, type RunStepImpl, type StepAuthFn } from "../src/engine.ts";
import { main } from "../src/cli.ts";
import type { LoopFn, StepOptions, StepStartedData } from "../src/types.ts";
import type { RunStepArgs } from "../src/engine.ts";

// ---------------------------------------------------------------------------
// resolveEnv: declared passthrough (§9)
// ---------------------------------------------------------------------------

test("resolveEnv: declared-and-present vars pass through under agent and are secrets", () => {
  process.env.ETIUM_TEST_MODELVAR = "supersecret-value-123"; // name misses SECRET_NAME on purpose
  try {
    const r = resolveEnv(undefined, ["ETIUM_TEST_MODELVAR", "ETIUM_TEST_ABSENT"]);
    assert.equal(r.env.ETIUM_TEST_MODELVAR, "supersecret-value-123");
    assert.ok(!("ETIUM_TEST_ABSENT" in r.env));
    assert.ok(r.secrets.includes("supersecret-value-123"));
  } finally {
    delete process.env.ETIUM_TEST_MODELVAR;
  }
});

test("resolveEnv: undeclared host vars stay stripped under agent; env.add beats passthrough", () => {
  process.env.ETIUM_TEST_MODELVAR = "supersecret-value-123";
  process.env.ETIUM_TEST_OTHER_KEY = "should-not-leak-456";
  try {
    const r = resolveEnv({ add: { ETIUM_TEST_MODELVAR: "explicit-override" } }, ["ETIUM_TEST_MODELVAR"]);
    assert.equal(r.env.ETIUM_TEST_MODELVAR, "explicit-override");
    assert.ok(!("ETIUM_TEST_OTHER_KEY" in r.env));
  } finally {
    delete process.env.ETIUM_TEST_MODELVAR;
    delete process.env.ETIUM_TEST_OTHER_KEY;
  }
});

test("resolveEnv: declared values are secrets under host even when the name heuristic misses", () => {
  process.env.ETIUM_TEST_MODELVAR = "supersecret-value-123";
  try {
    const r = resolveEnv({ profile: "host" }, ["ETIUM_TEST_MODELVAR"]);
    assert.equal(r.env.ETIUM_TEST_MODELVAR, "supersecret-value-123");
    assert.ok(r.secrets.includes("supersecret-value-123"));
  } finally {
    delete process.env.ETIUM_TEST_MODELVAR;
  }
});

// ---------------------------------------------------------------------------
// checkHarnessAuth (§6.3): definitive vs indeterminate
// ---------------------------------------------------------------------------

const execAdapter = getAdapter("exec");

test("checkHarnessAuth: no declaration => trivially ok; exec/replay stay credential-free", () => {
  assert.equal(execAdapter.auth, undefined);
  assert.equal(getAdapter("replay").auth, undefined);
  const r = checkHarnessAuth("exec");
  assert.deepEqual(r, { ok: true, authEnv: [] });
});

test("checkHarnessAuth: failing check is definitive and carries the remedy", () => {
  execAdapter.auth = { check: { cmd: "false", args: [] }, remedy: "fake login" };
  try {
    const r = checkHarnessAuth("exec");
    assert.equal(r.ok, false);
    assert.match((r as { detail: string }).detail, /not authenticated — run: fake login/);
  } finally {
    execAdapter.auth = undefined;
  }
});

test("checkHarnessAuth: missing binary is definitive; passing check is ok; timeout proceeds", () => {
  execAdapter.auth = { check: { cmd: "etium-no-such-binary-xyz", args: [] }, remedy: "install it" };
  try {
    const missing = checkHarnessAuth("exec");
    assert.equal(missing.ok, false);
    assert.match((missing as { detail: string }).detail, /not runnable .*ENOENT.* — run: install it/);

    execAdapter.auth = { check: { cmd: "true", args: [] } };
    assert.equal(checkHarnessAuth("exec").ok, true);

    execAdapter.auth = { check: { cmd: "sleep", args: ["5"] } };
    assert.equal(checkHarnessAuth("exec", 200).ok, true); // indeterminate => proceed
  } finally {
    execAdapter.auth = undefined;
  }
});

// ---------------------------------------------------------------------------
// runStep: passthrough reaches the child; values are redacted everywhere (§9)
// ---------------------------------------------------------------------------

function scaffold() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-auth-"));
  const runDir = path.join(base, "run");
  const stepDir = path.join(runDir, "steps", "001-t.0");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(stepDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { runDir, stepDir, workspace };
}

function stepArgs(opts: StepOptions): RunStepArgs {
  const s = scaffold();
  return {
    runDir: s.runDir,
    stepDir: s.stepDir,
    name: "t",
    occ: 0,
    opts,
    prompt: "",
    workspace: s.workspace,
    emitActivity: () => {},
    emitWarning: () => {},
  };
}

function readRaw(a: RunStepArgs, rawFile: string): string {
  const p = path.join(a.runDir, rawFile);
  if (p.endsWith(".zst")) return execSync(`zstd -d -c ${JSON.stringify(p)}`).toString("utf8");
  return fs.readFileSync(p, "utf8");
}

test("runStep: declared passthrough reaches the child and is redacted from raw", async () => {
  process.env.ETIUM_TEST_MODELVAR = "supersecret-value-123";
  execAdapter.auth = { env: ["ETIUM_TEST_MODELVAR"] };
  try {
    const a = stepArgs({ harness: "exec", command: 'echo "cred=$ETIUM_TEST_MODELVAR"' });
    const r = await runStep(a);
    assert.equal(r.status, "ok");
    const raw = readRaw(a, r.rawFile);
    assert.match(raw, /cred=\[redacted\]/);
    assert.ok(!raw.includes("supersecret-value-123"));
  } finally {
    execAdapter.auth = undefined;
    delete process.env.ETIUM_TEST_MODELVAR;
  }
});

test("runStep: grader output is redacted before grade.txt is written", async () => {
  const a = stepArgs({
    harness: "exec",
    command: "true",
    grade: 'echo "leak=$ETIUM_TEST_TOKEN"; true',
    env: { add: { ETIUM_TEST_TOKEN: "hunter2hunter2" } },
  });
  const r = await runStep(a);
  assert.equal(r.passed, true);
  const gradeRel = r.artifacts.find((p) => p.endsWith("grade.txt"))!;
  const grade = fs.readFileSync(path.join(a.runDir, gradeRel), "utf8");
  assert.match(grade, /leak=\[redacted\]/);
  assert.ok(!grade.includes("hunter2hunter2"));
});

// ---------------------------------------------------------------------------
// Engine: the pre-spawn gate records nothing; replay never re-checks (§6.3)
// ---------------------------------------------------------------------------

function tmpRun(): { runDir: string; workspace: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-auth-eng-"));
  const runDir = path.join(base, "runs", "r1");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  return { runDir, workspace };
}

const okImpl: RunStepImpl = async () => ({
  status: "ok",
  exit: 0,
  rawFile: "steps/x/raw.jsonl",
  rawSha256: "0".repeat(64),
  artifacts: [],
  passed: true,
});

async function attach(runDir: string, workspace: string, loopFn: LoopFn, stepAuth?: StepAuthFn) {
  const state = loadState(runDir);
  const writer = new LedgerWriter(runDir, "r1", state.seq);
  try {
    return await executeLoop({
      runDir,
      runId: "r1",
      task: "",
      writer,
      state,
      loopFn,
      loopDir: workspace,
      params: {},
      workspace,
      preapprovals: [],
      runStepImpl: okImpl,
      stepAuth,
      pollMs: 5,
    });
  } finally {
    writer.close();
  }
}

test("engine: auth failure appends no step.started; fixed auth resumes into occ 0; replay skips the gate", async () => {
  const { runDir, workspace } = tmpRun();
  const loop: LoopFn = async (run) => {
    await run.step("a", { harness: "exec", command: "true" });
  };

  const out1 = await attach(runDir, workspace, loop, () => ({
    ok: false,
    detail: "harness exec not authenticated — run: fake login",
  }));
  assert.equal(out1, "error");
  let evts = readLedger(runDir);
  assert.ok(!evts.some((e) => e.type === "step.started"));
  const completed1 = evts.filter((e) => e.type === "run.completed").at(-1)!;
  assert.match(
    (completed1.data as { summary?: string }).summary ?? "",
    /not authenticated — run: fake login/,
  );

  const out2 = await attach(runDir, workspace, loop, () => ({ ok: true, authEnv: ["ETIUM_TEST_MODELVAR"] }));
  assert.equal(out2, "done");
  evts = readLedger(runDir);
  const started = evts.filter((e) => e.type === "step.started");
  assert.equal(started.length, 1);
  const sd = started[0]!.data as StepStartedData;
  assert.equal(sd.occ, 0); // no occurrence was burned by the failed gate
  assert.deepEqual(sd.authEnv, ["ETIUM_TEST_MODELVAR"]);

  // Replay: memo hits return before the gate — broken auth must not block them.
  const out3 = await attach(runDir, workspace, loop, () => {
    throw new Error("stepAuth must not be consulted for memoized steps");
  });
  assert.equal(out3, "done");
});

// ---------------------------------------------------------------------------
// End to end through the CLI: fail closed, fix, `etium resume` (§6.3)
// ---------------------------------------------------------------------------

test("e2e: auth-failed run errors with the remedy and resumes cleanly after the fix", async () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "etium-auth-e2e-"));
  const loopFile = path.join(b, "one-step.ts");
  fs.writeFileSync(
    loopFile,
    `export default async function (run: any) {
      await run.step("work", { harness: "exec", command: "echo done > done.txt" });
    }\n`,
  );

  execAdapter.auth = { check: { cmd: "false", args: [] }, remedy: "fake login" };
  try {
    const rc1 = await main(["run", "auth gated", "--dir", b, "--loop", loopFile, "--sync"]);
    assert.equal(rc1, 1);
  } finally {
    execAdapter.auth = undefined;
  }
  const runDir = fs
    .readdirSync(path.join(b, "runs"))
    .map((n) => path.join(b, "runs", n))[0]!;
  let evts = readLedger(runDir);
  assert.ok(!evts.some((e) => e.type === "step.started"));
  assert.match(
    (evts.at(-1)!.data as { summary?: string }).summary ?? "",
    /not authenticated — run: fake login/,
  );

  const rc2 = await main(["resume", path.basename(runDir), "--dir", b, "--sync"]);
  assert.equal(rc2, 0);
  const st = loadState(runDir);
  assert.equal(st.completed?.status, "done");
  evts = readLedger(runDir);
  assert.equal(evts.filter((e) => e.type === "step.started").length, 1);
});

test("e2e: an errored run can be abandoned instead of resumed", async () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "etium-auth-e2e-"));
  const loopFile = path.join(b, "one-step.ts");
  fs.writeFileSync(
    loopFile,
    `export default async function (run: any) {
      await run.step("work", { harness: "exec", command: "true" });
    }\n`,
  );
  execAdapter.auth = { check: { cmd: "false", args: [] }, remedy: "fake login" };
  try {
    assert.equal(await main(["run", "doomed", "--dir", b, "--loop", loopFile, "--sync"]), 1);
  } finally {
    execAdapter.auth = undefined;
  }
  const runDir = fs.readdirSync(path.join(b, "runs")).map((n) => path.join(b, "runs", n))[0]!;
  assert.equal(loadState(runDir).completed?.status, "error");
  assert.equal(await main(["abandon", path.basename(runDir), "--dir", b, "--reason", "not worth fixing"]), 0);
  assert.equal(loadState(runDir).completed?.status, "abandoned");
});

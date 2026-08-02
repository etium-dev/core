import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.ts";
import { readLedger, loadState } from "../src/ledger.ts";
import { readLock } from "../src/lock.ts";

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "etium-e2e-"));
}
function runDirs(b: string): string[] {
  const d = path.join(b, "runs");
  return fs.existsSync(d) ? fs.readdirSync(d).map((n) => path.join(d, n)) : [];
}
function onlyRunDir(b: string): string {
  const rs = runDirs(b);
  assert.equal(rs.length, 1);
  return rs[0]!;
}
const lines = (p: string) => fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("e2e: ralph with exec harness iterates until the check passes", async () => {
  const b = tmpBase();
  const ws = path.join(b, "ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "PROMPT.md"), "echo hi >> out.log");
  const rc = await main([
    "run", "append until two lines",
    "--dir", b, "--workspace", ws, "--harness", "exec", "--sync",
    "--param", "check=test $(wc -l < out.log) -ge 2",
    "--param", "iterations=5",
  ]);
  assert.equal(rc, 0);
  assert.equal(lines(path.join(ws, "out.log")).length, 2);
  const evts = readLedger(onlyRunDir(b));
  const steps = evts.filter((e) => e.type === "step.completed").map((e) => {
    const d = e.data as { step: { name: string; occ: number }; passed?: boolean };
    return `${d.step.name}.${d.step.occ}:${d.passed}`;
  });
  assert.deepEqual(steps, ["iterate.0:true", "check.0:false", "iterate.1:true", "check.1:true"]);
  assert.equal(evts.at(-1)!.type, "run.completed");
  assert.ok(fs.existsSync(path.join(onlyRunDir(b), "state.json")));
});

test("e2e: park at a gate, approve with a note, note reaches the next prompt", async () => {
  const b = tmpBase();
  const loopFile = path.join(b, "gatey.ts");
  fs.writeFileSync(
    loopFile,
    `export default async function (run: any) {
      await run.step("build", { harness: "exec", command: "echo built > b.txt" });
      const d = await run.gate("ship-it", { show: ["b.txt"] });
      await run.step("ship", { harness: "exec", command: \`echo shipped \${d.decision} > s.txt\` });
    }\n`,
  );
  const rc1 = await main(["run", "gated ship", "--dir", b, "--loop", loopFile, "--sync"]);
  assert.equal(rc1, 0);
  const runDir = onlyRunDir(b);
  assert.equal(loadState(runDir).status, "parked");
  const runId = path.basename(runDir);

  const rc2 = await main(["approve", runId, "ship-it", "--note", "LGTM, ship it", "--dir", b, "--sync"]);
  assert.equal(rc2, 0);
  const st = loadState(runDir);
  assert.equal(st.status, "completed");
  assert.equal(st.completed!.status, "done");
  const ws = path.join(runDir, "ws");
  assert.equal(fs.readFileSync(path.join(ws, "s.txt"), "utf8").trim(), "shipped approve");
  const decided = readLedger(runDir).find((e) => e.type === "gate.decided")!;
  assert.match((decided.data as { by: string }).by, /.+/);
  assert.equal((decided.data as { via: string }).via, "cli");
  const shipDir = fs.readdirSync(path.join(runDir, "steps")).find((n) => n.includes("ship."))!;
  const prompt = fs.readFileSync(path.join(runDir, "steps", shipDir, "prompt.md"), "utf8");
  assert.match(prompt, /Operator notes:\n- LGTM, ship it/);

  // Fail-closed: deciding a gate that is not open is refused.
  const rc3 = await main(["approve", runId, "ship-it", "--dir", b, "--sync"]);
  assert.equal(rc3, 1);
});

test("e2e: reject flows into the loop's decision", async () => {
  const b = tmpBase();
  const loopFile = path.join(b, "r.ts");
  fs.writeFileSync(
    loopFile,
    `export default async function (run: any) {
      const d = await run.gate("go");
      if (d.decision === "reject") return run.abandon("vetoed: " + (d.note ?? ""));
      await run.step("go", { harness: "exec", command: "true" });
    }\n`,
  );
  await main(["run", "veto me", "--dir", b, "--loop", loopFile, "--sync"]);
  const runDir = onlyRunDir(b);
  await main(["reject", path.basename(runDir), "go", "--note", "wrong branch", "--dir", b, "--sync"]);
  const st = loadState(runDir);
  assert.equal(st.completed!.status, "abandoned");
  assert.match(st.completed!.summary!, /vetoed: wrong branch/);
});

test("e2e: abandon a parked run from the CLI", async () => {
  const b = tmpBase();
  const loopFile = path.join(b, "g.ts");
  fs.writeFileSync(loopFile, `export default async (run: any) => { await run.gate("g"); }\n`);
  await main(["run", "to abandon", "--dir", b, "--loop", loopFile, "--sync"]);
  const runDir = onlyRunDir(b);
  const rc = await main(["abandon", path.basename(runDir), "--reason", "superseded by other work", "--dir", b]);
  assert.equal(rc, 0);
  const st = loadState(runDir);
  assert.equal(st.completed!.status, "abandoned");
});

test("e2e crash-only: SIGKILL the supervisor mid-step; tick recovers; completed steps exactly-once, interrupted step at-least-once", async () => {
  const b = tmpBase();
  const loopFile = path.join(b, "crashy.ts");
  fs.writeFileSync(
    loopFile,
    `export default async function (run: any) {
      await run.step("one", { harness: "exec", command: "echo 1 >> c1.txt" });
      await run.step("two", { harness: "exec", command: "echo 2 >> c2.txt; sleep 1.2" });
    }\n`,
  );
  // Real detached supervisor (no --sync): this is the production path.
  const rc = await main(["run", "crash target", "--dir", b, "--loop", loopFile]);
  assert.equal(rc, 0);
  const runDir = onlyRunDir(b);
  const ws = path.join(runDir, "ws");

  // Wait until step "two" is running, then SIGKILL the supervisor.
  const deadline = Date.now() + 8000;
  for (;;) {
    if (fs.existsSync(path.join(ws, "c2.txt"))) break;
    assert.ok(Date.now() < deadline, `step two never started; log:\n${fs.existsSync(path.join(runDir, "supervisor.log")) ? fs.readFileSync(path.join(runDir, "supervisor.log"), "utf8") : "(none)"}`);
    await sleep(50);
  }
  // While the supervisor is live, tick must skip it.
  const { tickOnce } = await import("../src/tick.ts");
  const live = await tickOnce(b, "unused", true);
  assert.deepEqual(live.map((a) => a.action), ["skip-running"]);

  const lock = readLock(runDir)!;
  process.kill(lock.pid, "SIGKILL");
  await sleep(100);

  const actions = await tickOnce(b, "unused", true); // sync: supervise inline
  assert.deepEqual(actions.map((a) => a.action), ["resume"]);

  const st = loadState(runDir);
  assert.equal(st.status, "completed");
  assert.equal(st.completed!.status, "done");
  assert.equal(lines(path.join(ws, "c1.txt")).length, 1, "completed step must not re-run");
  assert.equal(lines(path.join(ws, "c2.txt")).length, 2, "interrupted step re-runs (at-least-once)");
  const evts = readLedger(runDir);
  const interrupted = evts.find((e) => e.type === "run.interrupted")!;
  assert.equal((interrupted.data as { reason: string }).reason, "stale-lock");
  const twoStarts = evts.filter((e) => e.type === "step.started" && (e.data as { name: string }).name === "two");
  assert.equal(twoStarts.length, 2);

  // Idempotence: everything is settled; tick does nothing.
  const again = await tickOnce(b, "unused", true);
  assert.deepEqual(again.map((a) => a.action), ["skip-completed"]);
});

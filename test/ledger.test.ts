import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fold, LedgerWriter, ledgerPath, readLedger, repairLedger } from "../src/ledger.ts";

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ledger-"));
  fs.mkdirSync(path.join(d, "r"), { recursive: true });
  return path.join(d, "r");
}

test("append/read roundtrip with monotonic seq", () => {
  const runDir = tmp();
  const w = new LedgerWriter(runDir, "r", 0);
  w.append("run.created", { taskSha256: "x", loop: "l", params: {}, workspace: "w", etiumVersion: "0" });
  w.append("supervisor.started", { pid: 1, host: "h" });
  w.close();
  const evts = readLedger(runDir);
  assert.deepEqual(evts.map((e) => [e.seq, e.type]), [[1, "run.created"], [2, "supervisor.started"]]);
  const w2 = new LedgerWriter(runDir, "r", evts.at(-1)!.seq);
  const e3 = w2.append("run.parked", { gates: [] });
  w2.close();
  assert.equal(e3.seq, 3);
});

test("torn trailing line is truncated on repair; writer resumes cleanly", () => {
  const runDir = tmp();
  const w = new LedgerWriter(runDir, "r", 0);
  w.append("run.created", { taskSha256: "x", loop: "l", params: {}, workspace: "w", etiumVersion: "0" });
  w.append("supervisor.started", { pid: 1, host: "h" });
  w.close();
  fs.appendFileSync(ledgerPath(runDir), '{"v":1,"ts":"2026-'); // simulated torn write
  repairLedger(runDir);
  const evts = readLedger(runDir);
  assert.equal(evts.length, 2);
  const w2 = new LedgerWriter(runDir, "r", evts.at(-1)!.seq);
  w2.append("run.interrupted", { reason: "stale-lock" });
  w2.close();
  const after = readLedger(runDir);
  assert.deepEqual(after.map((e) => e.seq), [1, 2, 3]);
});

test("mid-file corruption is localized to the line", () => {
  const runDir = tmp();
  const w = new LedgerWriter(runDir, "r", 0);
  w.append("supervisor.started", { pid: 1, host: "h" });
  w.close();
  fs.appendFileSync(ledgerPath(runDir), "@@corrupt@@\n");
  const w2 = new LedgerWriter(runDir, "r", 1);
  w2.append("run.parked", { gates: [] });
  w2.close();
  const evts = readLedger(runDir);
  assert.deepEqual(evts.map((e) => e.type), ["supervisor.started", "run.parked"]);
});

test("fold derives status through the lifecycle", () => {
  const runDir = tmp();
  const w = new LedgerWriter(runDir, "r", 0);
  w.append("run.created", { taskSha256: "x", loop: "l", params: {}, workspace: "w", etiumVersion: "0" });
  assert.equal(fold("r", readLedger(runDir)).status, "created");
  w.append("supervisor.started", { pid: 1, host: "h" });
  assert.equal(fold("r", readLedger(runDir)).status, "running");
  w.append("gate.opened", { name: "g", occ: 0, options: ["approve", "reject"], show: [] });
  w.append("run.parked", { gates: [{ name: "g", occ: 0 }] });
  assert.equal(fold("r", readLedger(runDir)).status, "parked");
  w.append("run.interrupted", { reason: "stale-lock" });
  assert.equal(fold("r", readLedger(runDir)).status, "interrupted");
  w.append("run.completed", { status: "done" });
  w.close();
  const st = fold("r", readLedger(runDir));
  assert.equal(st.status, "completed");
  assert.equal(st.gates.get("g.0")?.decided, undefined);
});

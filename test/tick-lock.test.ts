// The tick's single-writer lock is crash-only: a holder that died keeps the
// lock for at most one interval — the next tick verifies pid-liveness on
// this host and steals, loudly. A live holder is honored; foreign-host
// locks fall back to age; the old bare-pid file format still reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLedger } from "../src/ledger.ts";
import { createRun } from "../src/supervisor.ts";
import { tickOnce } from "../src/tick.ts";

const LOOP = `export default async function (run) {
  await run.step("go", { harness: "exec", command: "true" });
}
`;

test("tick lock: live holder honored; dead holder stolen next tick (old format too); aged foreign lock stolen; own release only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ticklock-"));
  const base = path.join(root, ".etium");
  const loopPath = path.join(root, "loop.ts");
  fs.writeFileSync(loopPath, LOOP);
  const { runDir } = createRun(base, { task: "x", loop: loopPath, params: {} });
  const lock = path.join(base, ".tick.lock");

  // A live holder (this very process) is honored — nothing runs.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  let actions = await tickOnce(base, "unused-entry", true);
  assert.deepEqual(actions, [{ run: "-", action: "skip-running", detail: "another tick holds the lock" }]);
  assert.ok(fs.existsSync(lock), "a live holder's lock is never deleted");

  // A dead holder — bare-pid pre-0.12.3 format — is stolen immediately.
  const dead = spawnSync("true").pid!; // exited: its pid no longer answers
  fs.writeFileSync(lock, String(dead));
  actions = await tickOnce(base, "unused-entry", true);
  assert.ok(
    actions.some((a) => a.action === "recover" && /stole stale tick lock \(holder pid \d+ not running\)/.test(a.detail ?? "")),
    `loud steal missing: ${JSON.stringify(actions)}`,
  );
  assert.equal(readLedger(runDir).at(-1)!.type, "run.completed", "the stealing tick did real work");
  assert.ok(!fs.existsSync(lock), "the stealing tick released its own lock");

  // A fresh foreign-host lock is honored (we cannot signal its pid)…
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: "some-other-host" }));
  actions = await tickOnce(base, "unused-entry", true);
  assert.equal(actions[0]!.action, "skip-running");
  // …until it ages past the staleness threshold.
  const past = new Date(Date.now() - 6 * 60_000);
  fs.utimesSync(lock, past, past);
  actions = await tickOnce(base, "unused-entry", true);
  assert.ok(actions.some((a) => a.action === "recover"));
  assert.ok(!fs.existsSync(lock));
});

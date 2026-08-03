// Surfaces (§10.3): tick polls tasks and decisions in, projects run state
// out. Covers: task idempotency by key, decision delivery with fail-closed
// validation, cursor persistence and opacity, projection views, and a broken
// surface not blocking reconciliation.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLedger } from "../src/ledger.ts";
import { tickOnce } from "../src/tick.ts";
import type { RunView, Surface, SurfaceDecision, SurfaceTask } from "../src/types.ts";

const GATE_LOOP = `
export default async function (run) {
  const d = await run.gate("route", { options: ["debug", "plan"] });
  await run.step("chosen", { harness: "exec", command: \`echo \${d.decision} > out.txt\` });
}
`;

function tmpBase(): { base: string; loopPath: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-surface-"));
  const loopPath = path.join(base, "gate-loop.ts");
  fs.writeFileSync(loopPath, GATE_LOOP);
  return { base, loopPath };
}

/** A scriptable in-memory surface. */
function fakeSurface(id: string) {
  const s = {
    id,
    tasks: [] as SurfaceTask[],
    decisions: [] as SurfaceDecision[],
    nextCursor: null as string | null,
    seenCursor: undefined as string | null | undefined,
    polledRuns: [] as RunView[][],
    projected: [] as RunView[],
    surface: undefined as unknown as Surface,
  };
  s.surface = {
    id,
    poll(ctx) {
      s.seenCursor = ctx.cursor;
      s.polledRuns.push(ctx.runs);
      const out = { tasks: s.tasks, decisions: s.decisions, cursor: s.nextCursor };
      s.tasks = [];
      s.decisions = [];
      return out;
    },
    project(run) {
      s.projected.push(run);
    },
  };
  return s;
}

test("surface tasks: created once per key, resumed same tick, params tagged", async () => {
  const { base, loopPath } = tmpBase();
  const f = fakeSurface("gh");
  f.tasks = [{ key: "issue-42:assigned:evt-1", task: "fix the thing", loop: loopPath }];
  f.nextCursor = "c1";

  const a1 = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.equal(f.seenCursor, null);
  assert.ok(a1.some((a) => a.action === "surface-task"));
  const runsDir = path.join(base, "runs");
  const runs = fs.readdirSync(runsDir);
  assert.equal(runs.length, 1);
  const runDir = path.join(runsDir, runs[0]!);
  const created = readLedger(runDir).find((e) => e.type === "run.created")!;
  assert.equal(
    (created.data as { params: Record<string, string> }).params["surface.task"],
    "gh:issue-42:assigned:evt-1",
  );
  // sync tick resumed the created run to its gate in the same tick
  assert.ok(readLedger(runDir).some((e) => e.type === "run.parked"));

  // Redelivery of the same key (cursor lost, webhook replay, …): no second run.
  f.tasks = [{ key: "issue-42:assigned:evt-1", task: "fix the thing", loop: loopPath }];
  const a2 = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.equal(f.seenCursor, "c1"); // cursor round-tripped opaquely
  assert.ok(a2.some((a) => a.action === "surface-skip"));
  assert.equal(fs.readdirSync(runsDir).length, 1);
});

test("surface decisions: validated fail-closed, delivered via mailbox, resumed same tick", async () => {
  const { base, loopPath } = tmpBase();
  const f = fakeSurface("gh");
  f.tasks = [{ key: "evt-1", task: "route me", loop: loopPath }];
  await tickOnce(base, "unused-entry", true, [f.surface]);
  const runsDir = path.join(base, "runs");
  const runId = fs.readdirSync(runsDir)[0]!;
  const runDir = path.join(runsDir, runId);

  // Undeclared option and unknown run: dropped, run stays parked.
  f.decisions = [
    { run: runId, gate: "route", decision: "ship-it", by: "carlospche" },
    { run: "no-such-run", gate: "route", decision: "plan", by: "carlospche" },
  ];
  const a1 = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.equal(a1.filter((a) => a.action === "surface-drop").length, 2);
  assert.ok(!readLedger(runDir).some((e) => e.type === "gate.decided"));

  // Valid option: mailbox → same-tick resume → loop branches on the choice.
  f.decisions = [{ run: runId, gate: "route", decision: "plan", by: "carlospche", note: "fix plan first" }];
  const a2 = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.ok(a2.some((a) => a.action === "surface-decision"));
  const decided = readLedger(runDir).find((e) => e.type === "gate.decided")!;
  assert.deepEqual(
    (({ decision, by, via, note }) => ({ decision, by, via, note }))(
      decided.data as { decision: string; by: string; via: string; note?: string },
    ),
    { decision: "plan", by: "carlospche", via: "gh", note: "fix plan first" },
  );
  const ws = path.join(runDir, "ws", "out.txt");
  assert.equal(fs.readFileSync(ws, "utf8").trim(), "plan");
});

test("projection: every run projected with open gates and their options; completion visible next tick", async () => {
  const { base, loopPath } = tmpBase();
  const f = fakeSurface("gh");
  f.tasks = [{ key: "evt-1", task: "route me", loop: loopPath }];
  await tickOnce(base, "unused-entry", true, [f.surface]);
  const parkedView = f.projected.at(-1)!;
  assert.equal(parkedView.status, "parked");
  assert.equal(parkedView.openGates.length, 1);
  assert.deepEqual(parkedView.openGates[0]!.options, ["debug", "plan"]);
  assert.equal(parkedView.params["surface"], "gh");

  f.decisions = [{ run: parkedView.id, gate: "route", decision: "debug", by: "carlospche" }];
  await tickOnce(base, "unused-entry", true, [f.surface]);
  const finalView = f.projected.at(-1)!;
  assert.equal(finalView.status, "completed");
  assert.equal(finalView.completed?.status, "done");
  assert.equal(finalView.openGates.length, 0);
});

test("a throwing surface reports an error and does not block reconciliation", async () => {
  const { base, loopPath } = tmpBase();
  const good = fakeSurface("ok");
  good.tasks = [{ key: "evt-1", task: "work", loop: loopPath }];
  const bad: Surface = {
    id: "broken",
    poll() {
      throw new Error("api down");
    },
  };
  const actions = await tickOnce(base, "unused-entry", true, [bad, good.surface]);
  assert.ok(actions.some((a) => a.action === "surface-error" && /broken poll: api down/.test(a.detail ?? "")));
  assert.ok(actions.some((a) => a.action === "surface-task"));
  assert.equal(fs.readdirSync(path.join(base, "runs")).length, 1);
});

test("surface abandons: lifecycle facts terminate runs; completed runs are skipped", async () => {
  const { base, loopPath } = tmpBase();
  const f = fakeSurface("gh");
  f.tasks = [{ key: "evt-1", task: "route me", loop: loopPath }];
  await tickOnce(base, "unused-entry", true, [f.surface]);
  const runId = fs.readdirSync(path.join(base, "runs"))[0]!;

  (f.surface.poll as unknown) = () => ({
    tasks: [],
    decisions: [],
    abandons: [{ run: runId, reason: "issue closed" }],
    cursor: null,
  });
  const a = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.ok(a.some((x) => x.action === "surface-abandon"));
  const last = readLedger(path.join(base, "runs", runId)).at(-1)!;
  assert.deepEqual(last.data, { status: "abandoned", summary: "issue closed" });

  const again = await tickOnce(base, "unused-entry", true, [f.surface]);
  assert.ok(again.some((x) => x.action === "surface-skip" && /already completed/.test(x.detail ?? "")));
});

test("watchLoop: ticks on an interval and reports actions", async () => {
  const { base, loopPath } = tmpBase();
  const f = fakeSurface("gh");
  f.tasks = [{ key: "evt-1", task: "work", loop: loopPath }];
  const batches: unknown[][] = [];
  const { watchLoop } = await import("../src/tick.ts");
  await watchLoop(base, "unused-entry", [f.surface], 10, (a) => batches.push(a), 2);
  assert.equal(batches.length, 2);
  assert.ok((batches[0] as { action: string }[]).some((a) => a.action === "surface-task"));
});

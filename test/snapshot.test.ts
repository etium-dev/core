// Snapshot-at-creation (ADR-036): a run executes its own frozen copy of the
// loop, so library edits and etium upgrades never touch in-flight runs and a
// run directory replays hermetically.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRun, supervise } from "../src/supervisor.ts";
import { writeDecision } from "../src/lock.ts";

function tmpRoot(): { root: string; etiumBase: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-snap-"));
  return { root, etiumBase: path.join(root, ".etium") };
}

test("bare loop file: snapshot holds just the file; the run survives deleting the source", async () => {
  const { root, etiumBase } = tmpRoot();
  const loop = path.join(root, "noop.ts");
  fs.writeFileSync(
    loop,
    `export default async function (run) {
      await run.step("touch", { harness: "exec", command: "echo done > from-run.txt" });
    }\n`,
  );
  const { runDir } = createRun(etiumBase, { task: "t", loop });

  const cfg = JSON.parse(fs.readFileSync(path.join(runDir, "loop.json"), "utf8")) as {
    loop: string;
  };
  assert.equal(cfg.loop, path.join("loop", "noop.ts"), "loop.json points inside the run");
  assert.ok(fs.existsSync(path.join(runDir, "loop", "noop.ts")));

  fs.rmSync(loop); // the source is gone; the snapshot carries the run
  assert.equal(await supervise(runDir), "done");
  assert.equal(
    fs.readFileSync(path.join(runDir, "ws", "from-run.txt"), "utf8").trim(),
    "done",
  );
});

test("library loop: whole dir snapshots; mid-run edits neither diverge nor leak into prompts", async () => {
  const { root, etiumBase } = tmpRoot();
  const lib = path.join(root, "lib");
  fs.mkdirSync(path.join(lib, "templates"), { recursive: true });
  fs.writeFileSync(path.join(lib, "templates", "P.md"), "version one");
  const loop = path.join(lib, "loop.ts");
  fs.writeFileSync(
    loop,
    `export default async function (run) {
      await run.step("a", { harness: "exec", command: "true", prompt: run.t("templates/P.md") });
      await run.gate("hold");
      await run.step("b", { harness: "exec", command: "true", prompt: run.t("templates/P.md") });
    }\n`,
  );
  const { runDir } = createRun(etiumBase, { task: "t", loop });
  assert.ok(fs.existsSync(path.join(runDir, "loop", "templates", "P.md")));
  assert.equal(await supervise(runDir), "parked");

  // Upgrade/edit the library mid-run: new template content, new loop code.
  fs.writeFileSync(path.join(lib, "templates", "P.md"), "version two");
  fs.writeFileSync(loop, `export default async function () { throw new Error("new loop"); }\n`);

  writeDecision(runDir, {
    name: "hold",
    occ: 0,
    decision: "approve",
    by: "t",
    via: "cli",
    ts: new Date().toISOString(),
  });
  assert.equal(await supervise(runDir), "done", "no DIVERGENCE from library edits");

  const stepB = fs.readdirSync(path.join(runDir, "steps")).find((d) => d.endsWith("-b.0"))!;
  assert.equal(
    fs.readFileSync(path.join(runDir, "steps", stepB, "prompt.md"), "utf8"),
    "version one",
    "prompts render from the frozen snapshot",
  );
});

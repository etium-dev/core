// ralph — the reference loop (§11): iterate a fresh-context agent step
// against the same prompt until a check passes, under an iteration guard.
// The contract (params, gates, artifacts) is README.md, next to this file.

import type { Run } from "@etium/core";

export default async function ralph(run: Run) {
  const max = Number(run.params.iterations ?? "30");
  const harness = run.params.harness ?? "codex";
  for (let i = 0; i < max; i++) {
    await run.step("iterate", {
      harness,
      model: run.params.model,
      prompt: run.t(run.params.prompt ?? "PROMPT.md"),
      fixture: run.params.fixture,
      inner: run.params.inner,
      budget: { wall: run.params.wall ?? "2h" },
    });
    if (!run.params.check) return;
    const check = await run.step("check", { harness: "exec", command: run.params.check });
    if (check.passed) return;
  }
  const d = await run.gate("iteration-guard");
  if (d.decision === "reject") await run.abandon("iteration guard rejected");
  // Approved: hand the (possibly noted) situation back as a fresh pass of the
  // loop body by recursing once more through the same code path.
  await ralph(run);
}

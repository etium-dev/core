// ralph — the reference loop (M0, §11): iterate a fresh-context agent step
// against the same prompt until a check passes, under an iteration guard.
// Bundled loops ship as .js (Node refuses to type-strip .ts inside
// node_modules); loops in YOUR project can be .ts with zero build.
//
// params:
//   prompt      template file (default PROMPT.md; loop dir then workspace)
//   check       shell command; exit 0 ends the loop (omit = single pass)
//   iterations  max agent steps before the guard gate (default 30)
//   harness     codex | replay | exec … (default codex)
//   model       passed through to the harness
//   fixture     replay harness only
//
/** @param {import("../src/types.ts").Run} run */
export default async function ralph(run) {
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
  // Approved: hand the (possibly noted) situation back as a fresh run of the
  // loop body by recursing once more through the same code path.
  await ralph(run);
}

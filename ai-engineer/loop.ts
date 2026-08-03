// The AI engineer: the predecessor state machine (AI_ENGINEER_STATE_MACHINE.md)
// as one etium loop. Surface-agnostic and CLI-complete: every transition is a
// gate decision (`etium decide` or a surface command like `/et plan`); every
// state is derived from loop position + open gates. Publication-free by
// design — this loop commits to its branch and opens gates; a surface
// projects branch → PR → status (ADR-011).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// In your own project: `import type { Run } from "etium"`.
import type { Run } from "../src/index.ts";

const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");
const read = (f: string) => fs.readFileSync(path.join(T, f), "utf8");
// Composition in code (WRITING_LOOPS.md): shared conventions + persona.
const persona = (stage: string) =>
  read("conventions.md") + "\n\n" + read(`${stage}.md`).replaceAll("{{stage}}", stage);

const ARTIFACT: Record<string, string> = {
  triage: "ai/INTAKE.md",
  debug: "ai/DIAGNOSIS.md",
  design: "ai/DESIGN.md",
  plan: "ai/PLAN.md",
  implement: "ai/REPORT.md",
};

export default async function aiEngineer(run: Run) {
  const harness = run.params.harness ?? "pi";
  const rounds = Number(run.params.rounds ?? "2");
  const done = new Set<string>();
  let show: string[] = [];

  // `command` is the dry-run hook: under `--harness exec`, `--param
  // cmd.<step>=…` scripts a step; real harness adapters ignore `command`.
  const step = (name: string, prompt: string, extra: object = {}) =>
    run.step(name, {
      harness,
      model: run.params.model,
      prompt: prompt.replaceAll("{{task}}", run.task),
      command: run.params[`cmd.${name}`],
      budget: { wall: run.params.wall ?? "2h" },
      ...extra,
    });

  // One stage: builder/reviewer rounds until the reviewer approves (and, for
  // implement, the check passes). The maker never grades its own homework.
  const converge = async (stage: string): Promise<"ready" | "wrapped-up"> => {
    for (;;) {
      for (let r = 0; r < rounds; r++) {
        const built = await step(stage, persona(stage), { artifacts: ["ai/*.md"] });
        if (built.status !== "ok") break;
        const check =
          stage === "implement"
            ? await run.step("check", { harness: "exec", command: run.params.check ?? "true" })
            : undefined;
        const review = await step(`${stage}-review`, persona("review"), {
          artifacts: ["ai/REVIEW.md"],
          grade: "grep -qi '^VERDICT: approve' ai/REVIEW.md",
        });
        show = [ARTIFACT[stage]!, "ai/REVIEW.md"];
        if (review.passed && (check?.passed ?? true)) return "ready";
      }
      const e = await run.gate(`${stage}-stuck`, {
        options: ["keep-going", "accept", "wrap-up"],
        show,
      });
      if (e.decision === "accept") return "ready";
      if (e.decision === "wrap-up") return "wrapped-up";
      // keep-going: another block of rounds.
    }
  };

  // Assignment starts intake only (predecessor invariant 1).
  const intake = await step("triage", persona("triage"), { artifacts: ["ai/INTAKE.md"] });
  if (intake.status === "ok") show = ["ai/INTAKE.md"];

  for (;;) {
    // The old label-guard rule ("no ai-implement without an accepted plan")
    // is now just the declared option set: implement isn't offered until a
    // plan converged and the human routed past it. Fail-closed for free.
    const options = ["triage", "debug", "design", "plan"];
    if (done.has("plan")) options.push("implement");
    if (done.has("implement")) options.push("wrap-up");

    const route = await run.gate("route", { options, show });
    if (route.decision === "wrap-up") return; // e.g. the PR merged (surface decides this)
    if (route.decision === "triage") {
      const again = await step("triage", persona("triage"), { artifacts: ["ai/INTAKE.md"] });
      if (again.status === "ok") show = ["ai/INTAKE.md"];
      continue;
    }
    const verdict = await converge(route.decision);
    if (verdict === "wrapped-up") return run.abandon(`${route.decision} wrapped up by operator`);
    done.add(route.decision);
  }
}

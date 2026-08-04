// The AI engineer as one etium loop: surface-agnostic and CLI-complete —
// every transition is a gate decision (`etium decide` or a surface command
// like `/et plan`); freestyle input is mapped to the vocabulary by an
// interpreter persona (ADR-023); publication is a surface's job, never the
// loop's. Artifact commits are the loop's own steps (ADR-017).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "@etium/core";

const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");
const read = (f: string) => fs.readFileSync(path.join(T, f), "utf8");
const persona = (stage: string) =>
  read("conventions.md") + "\n\n" + read(`${stage}.md`).replaceAll("{{stage}}", stage);
const reviewer = (stage: string) =>
  read("conventions.md") + "\n\n" + read("review.md").replaceAll("{{stage}}", stage) +
  "\n\n" + read(`${stage}-review.md`);

const ARTIFACT: Record<string, string> = {
  triage: "ai/INTAKE.md",
  debug: "ai/DIAGNOSIS.md",
  design: "ai/DESIGN.md",
  plan: "ai/PLAN.md",
  implement: "ai/REPORT.md",
};
const ROUTES = ["triage", "debug", "design", "plan"];

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

  // Artifact commits are the loop's job (ADR-017): guarded — no-op when
  // clean or outside a git checkout; loud on real failure.
  const commit = (label: string, all = false) =>
    run.step("commit", {
      harness: "exec",
      command: `if git rev-parse --git-dir >/dev/null 2>&1; then git add -A ${all ? "." : "ai"} && { git diff --cached --quiet || git commit -q -m "ai: ${label}"; }; fi`,
    });

  // A recorded read of one word out of an artifact — replay-exact.
  const artifactWord = (file: string, re: RegExp) => () => {
    const m = re.exec(fs.readFileSync(path.join(run.workspace, file), "utf8"));
    return m?.[1]?.toLowerCase() ?? "";
  };

  // Freestyle → vocabulary (ADR-023): the interpreter persona maps the
  // operator's words to one declared option, or asks to rephrase in
  // ai/REPLY.md. "" = unclear; the caller re-opens its gate showing the
  // question.
  const interpret = async (options: string[], msg: string): Promise<string> => {
    const prompt = read("conventions.md") + "\n\n" +
      read("interpret.md").replaceAll("{{options}}", options.join(" | ")).replaceAll("{{message}}", msg);
    await step("interpret", prompt, { artifacts: ["ai/REPLY.md"] });
    await commit("interpret");
    const w = await run.effect("interpreted", artifactWord("ai/REPLY.md", /^ACTION:\s*(\S+)/im));
    return options.includes(w as string) ? (w as string) : "";
  };

  // One stage: builder/reviewer rounds until the reviewer approves (and, for
  // implement, the check passes). The maker never grades its own homework.
  const converge = async (stage: string): Promise<"ready" | "wrapped-up"> => {
    for (;;) {
      for (let r = 0; r < rounds; r++) {
        const built = await step(stage, persona(stage), { artifacts: ["ai/*.md"] });
        await commit(stage, stage === "implement");
        if (built.status !== "ok") break;
        const check = stage === "implement"
          ? await run.step("check", { harness: "exec", command: run.params.check ?? "true" })
          : undefined;
        const review = await step(`${stage}-review`, reviewer(stage), {
          artifacts: ["ai/REVIEW.md"],
          grade: "grep -qi '^VERDICT: approve' ai/REVIEW.md",
        });
        await commit(`${stage}-review`);
        show = [ARTIFACT[stage]!, "ai/REVIEW.md"];
        if (review.passed && (check?.passed ?? true)) return "ready";
      }
      for (;;) {
        const e = await run.gate(`${stage}-stuck`, { options: ["keep-going", "accept", "wrap-up", "consider"], show });
        const d = e.decision === "consider" ? await interpret(["keep-going", "accept", "wrap-up"], e.note ?? "") : e.decision;
        if (d === "accept") return "ready";
        if (d === "wrap-up") return "wrapped-up";
        if (d === "keep-going") break; // another block of rounds
        show = ["ai/REPLY.md"]; // unclear: re-ask, question shown
      }
    }
  };

  const runStage = async (stage: string): Promise<boolean> => {
    if ((await converge(stage)) === "wrapped-up") {
      await run.abandon(`${stage} wrapped up by operator`);
      return false;
    }
    done.add(stage);
    return true;
  };

  const triage = async () => {
    const t = await step("triage", persona("triage").replaceAll("{{directive}}", run.params.directive ?? "none"), {
      artifacts: ["ai/INTAKE.md"],
    });
    await commit("triage");
    if (t.status === "ok") show = ["ai/INTAKE.md"];
    return t;
  };

  const intake = await triage();
  // A kickoff directive is the human's routing input, delivered early
  // (ADR-023): follow the intake's route without re-asking; anything
  // unparseable falls to the gate — fail closed.
  if (run.params.directive && intake.status === "ok") {
    const auto = await run.effect("auto-route", artifactWord("ai/INTAKE.md", /^##\s*Route\s*\n[\s*`_<]*(debug|design|plan)\b/im));
    if (auto && !(await runStage(auto as string))) return;
  }

  for (;;) {
    // Fail-closed routing: implement isn't offered until a plan converged.
    const options = [...ROUTES];
    if (done.has("plan")) options.push("implement");
    if (done.has("implement")) options.push("wrap-up");
    const route = await run.gate("route", { options: [...options, "consider"], show });
    const decision = route.decision === "consider" ? await interpret(options, route.note ?? "") : route.decision;
    if (!decision) { show = ["ai/REPLY.md"]; continue; }
    if (decision === "wrap-up") return; // e.g. the PR merged (surface decides this)
    if (decision === "triage") { await triage(); continue; }
    if (!(await runStage(decision))) return;
  }
}

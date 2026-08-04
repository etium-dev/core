// The AI engineer as one etium loop: surface-agnostic and CLI-complete —
// every transition is a gate decision (`etium decide` or a surface command
// like `/et plan`). The whole front door is one conversion: the operator's
// words → an option the state machine declares here, mapped by an
// interpreter persona; no mapping → a clarifying question, never a guess
// (ADR-023/026). Stages are self-sufficient — each persona studies the
// repository itself; nothing pre-digests it for them. Publication is a
// surface's job; artifact commits are the loop's own steps (ADR-017).

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
  debug: "ai/DIAGNOSIS.md",
  design: "ai/DESIGN.md",
  plan: "ai/PLAN.md",
  implement: "ai/REPORT.md",
};
const ROUTES = ["debug", "design", "plan"];

export default async function aiEngineer(run: Run) {
  const rounds = Number(run.params.rounds ?? "2");
  const done = new Set<string>();
  let show: string[] = [];

  // `command` is the dry-run hook: under `--harness exec`, `--param
  // cmd.<step>=…` scripts a step; real harness adapters ignore `command`.
  // Personas can run on different harnesses/models: `harness.<step>` and
  // `model.<step>` win over the loop-wide `harness`/`model` (ADR-025).
  const step = (name: string, prompt: string, extra: object = {}) =>
    run.step(name, {
      harness: run.params[`harness.${name}`] ?? run.params.harness ?? "pi",
      model: run.params[`model.${name}`] ?? run.params.model,
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

  // Words → vocabulary. An exact option word is taken literally (no model);
  // anything else goes to the interpreter persona, which may study the
  // repository but writes only ai/REPLY.md: `ACTION: <option>`, or
  // `ACTION: unclear` plus one question. "" = unclear; the caller re-opens
  // its gate showing the question. REPLY.md is working state, not an
  // artifact — it is never committed on its own.
  const interpret = async (options: string[], msg: string): Promise<string> => {
    if (options.includes(msg.trim().toLowerCase())) return msg.trim().toLowerCase();
    const prompt = read("conventions.md") + "\n\n" +
      read("interpret.md").replaceAll("{{options}}", options.join(" | ")).replaceAll("{{message}}", msg);
    await step("interpret", prompt, { artifacts: ["ai/REPLY.md"] });
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
      // An escalation, not a routine stop: the reason is the headline, and
      // the reviewer's blockers lead the shown files.
      let stuckShow = ["ai/REVIEW.md", ...show.filter((f) => f !== "ai/REVIEW.md")];
      for (;;) {
        const e = await run.gate(`${stage}-stuck`, {
          options: ["keep-going", "accept", "wrap-up", "consider"],
          show: stuckShow,
          reason: `the ${stage} reviewer still objects after ${rounds} round${rounds === 1 ? "" : "s"} — blockers in REVIEW.md`,
        });
        const d = e.decision === "consider" ? await interpret(["keep-going", "accept", "wrap-up"], e.note ?? "") : e.decision;
        if (d === "accept") return "ready";
        if (d === "wrap-up") return "wrapped-up";
        if (d === "keep-going") break; // another block of rounds
        stuckShow = ["ai/REPLY.md"]; // unclear: re-ask, question shown
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

  // The kickoff directive is the operator's words, delivered early: map and
  // go. Unclear falls to the route gate with the question shown — fail closed.
  if (run.params.directive) {
    const w = await interpret(ROUTES, run.params.directive);
    if (w) { if (!(await runStage(w))) return; }
    else show = ["ai/REPLY.md"];
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
    if (!(await runStage(decision))) return;
  }
}

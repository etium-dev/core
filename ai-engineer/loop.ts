// The AI engineer as one etium loop: surface-agnostic and CLI-complete —
// every transition is a gate decision (`etium decide` or a surface command
// like `/et plan`). The whole front door is one conversion: the operator's
// words → an option the state machine declares here, mapped by an
// interpreter persona; no mapping → a clarifying question, never a guess
// (ADR-023/026). Stages are self-sufficient — each persona studies the
// repository itself; nothing pre-digests it for them. Publication is a
// surface's job; artifact commits are the loop's own steps (ADR-017).

import { spawnSync } from "node:child_process";
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
const ROUTES = ["debug", "design"]; // plan is earned by a converged design — never offered cold

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
  // clean or outside a git checkout; loud on real failure. The resulting
  // sha is recorded so surfaces can link each round's exact documents.
  const commit = async (label: string, all = false) => {
    await run.step("commit", {
      harness: "exec",
      command: `if git rev-parse --git-dir >/dev/null 2>&1; then git add -A ${all ? "." : "ai"} && { git diff --cached --quiet || git commit -q -m "ai: ${label}"; }; fi`,
    });
    await run.effect("sha", () => (spawnSync("git", ["rev-parse", "HEAD"], { cwd: run.workspace, encoding: "utf8" }).stdout ?? "").trim());
  };

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

  // The operator's words are ground truth for the stage they steer
  // (ADR-033): the entry note, every stuck-gate note, and every mid-stage
  // mailbox note reach BOTH personas, every round, until the stage ends.
  const opBlock = (notes: string[]) => notes.length === 0 ? "" :
    `\n\n<operator_instructions>\nGround truth for this stage — these outrank repository documentation for this run:\n${notes.map((n) => `- ${n}`).join("\n")}\n</operator_instructions>\n`;

  // One stage: builder/reviewer rounds until the reviewer approves (and, for
  // implement, the check passes). The maker never grades its own homework.
  const converge = async (stage: string, entry?: string): Promise<void> => {
    const since = await run.effect("stage-start", () => new Date().toISOString());
    const ruling = entry ? [entry] : [];
    for (;;) {
      for (let r = 0; r < rounds; r++) {
        const arrived = JSON.parse(await run.effect("op-notes", () =>
          JSON.stringify(run.notes().filter((n) => n.ts >= since).map((n) => `${n.by}: ${n.text}`)))) as string[];
        const op = opBlock([...ruling, ...arrived]);
        const built = await step(stage, persona(stage) + op, { artifacts: [ARTIFACT[stage]!, "ai/*.md"] });
        await commit(stage, stage === "implement");
        if (built.status !== "ok") break;
        const check = stage === "implement"
          ? await run.step("check", { harness: "exec", command: run.params.check ?? "true" })
          : undefined;
        const review = await step(`${stage}-review`, reviewer(stage) + op, {
          artifacts: ["ai/REVIEW.md"],
          grade: "grep -qi '^VERDICT: approve' ai/REVIEW.md",
        });
        await commit(`${stage}-review`);
        show = [ARTIFACT[stage]!, "ai/REVIEW.md"];
        if (review.passed && (check?.passed ?? true)) return;
      }
      // Escalation: the reason is the headline; REVIEW.md leads the show.
      let stuckShow = ["ai/REVIEW.md", ...show.filter((f) => f !== "ai/REVIEW.md")];
      for (;;) {
        const e = await run.gate(`${stage}-stuck`, {
          options: ["keep-going", "accept", "consider"],
          show: stuckShow,
          reason: `the ${stage} reviewer still objects after ${rounds} round${rounds === 1 ? "" : "s"} — blockers in REVIEW.md`,
        });
        const d = e.decision === "consider" ? await interpret(["keep-going", "accept"], e.note ?? "") : e.decision;
        if (d === "accept") return;
        if (d === "keep-going") { if (e.note) ruling.push(e.note); break; } // more rounds, ruling standing
        stuckShow = ["ai/REPLY.md"]; // unclear: re-ask, question shown
      }
    }
  };

  const runStage = async (stage: string, entry?: string) => {
    await converge(stage, entry);
    done.add(stage);
  };

  // The one closing ceremony (ADR-035): retire ai/ and distill its SUMMARY
  // lines into the final commit; merging the PR is the human's act.
  const finalize = async () => {
    const msg = (await run.effect("finalize-msg", () => {
      const line = (f: string) => { try { return /^SUMMARY:\s*(.+)/m.exec(fs.readFileSync(path.join(run.workspace, f), "utf8"))?.[1] ?? ""; } catch { return ""; } };
      const parts = Object.entries({ Diagnosis: "ai/DIAGNOSIS.md", Design: "ai/DESIGN.md", Plan: "ai/PLAN.md", Report: "ai/REPORT.md" })
        .map(([t, f]) => (line(f) ? `${t}: ${line(f)}` : "")).filter(Boolean);
      return ["ai: finalize", "", ...parts, `Verified: ${run.params.check ?? "true"}`].join("\n");
    })) as string;
    await run.step("finalize", {
      harness: "exec",
      command: `if git rev-parse --git-dir >/dev/null 2>&1; then git rm -r -q --ignore-unmatch ai && { git diff --cached --quiet || git commit -q -m '${msg.replace(/'/g, "'\\''")}'; }; fi`,
    });
  };

  // The kickoff directive is the operator's words, delivered early: map and
  // go. Unclear falls to the route gate with the question shown — fail closed.
  if (run.params.directive) {
    const w = await interpret(ROUTES, run.params.directive);
    if (w) await runStage(w, run.params.directive);
    else show = ["ai/REPLY.md"];
  }

  for (;;) {
    // Fail-closed routing: every stage is earned — no plan without a
    // design (a mini-design is cheap by construction), no implement
    // without a plan, no finalize before implementation.
    const options = [...ROUTES];
    if (done.has("design")) options.push("plan");
    if (done.has("plan")) options.push("implement");
    if (done.has("implement")) options.push("finalize");
    const route = await run.gate("route", { options: [...options, "consider"], show,
      reason: done.has("implement") ? "implementation approved — review the draft PR; `/et finalize` retires the ai/ documents into the final commit message; merging then closes the issue" : undefined });
    const decision = route.decision === "consider" ? await interpret(options, route.note ?? "") : route.decision;
    if (!decision) { show = ["ai/REPLY.md"]; continue; }
    if (decision === "finalize") { await finalize(); return; }
    await runStage(decision, route.note);
  }
}

# Etium

**The outer loop for coding agents.**

---

## Position

Etium is a supervisor for headless coding agents. It owns the outer loop — tasks, runs, budgets, gates, and the event ledger — and delegates the entire inner loop (context, tools, model calls) to existing harnesses via thin adapters. Pi's equation is agent = model + minimal harness; etium's is team = harnesses + minimal loop. Etium is the loop.

One product question must be answered up front: why does etium exist when Claude Code and Codex both now ship all five loop building blocks, including `/goal` with an independent model checking the stop condition? Because those primitives are per-vendor, per-session, and opaque — the outer state lives inside their product. Etium's value is exactly what they can't give you: harness neutrality (swap Claude Code for Codex, Pi, or OpenHands per step), multi-day multi-stage lifecycles with human gates, and a durable, auditable, replayable ledger that you own as files. Etium grew out of a production prototype — a multi-persona, human-gated AI engineering pipeline — proof that there's a real workflow here that no vendor loop covers.

---

## What a loop looks like

A loop is ordinary code. No DSL, no YAML, no build step.

```ts
export default async function planImplement(run: Run) {
  const plan = await run.step("plan", { harness: "codex", prompt: t("plan.md"),
    artifacts: ["PLAN.md"], budget: { wall: "2h" } });

  await run.gate("plan-approved", { show: [plan.artifact("PLAN.md")] });

  await run.step("implement", { harness: "codex", prompt: t("implement.md"),
    budget: { wall: "10h" } });

  const check = await run.step("verify", { harness: "claude", model: "opus",
    prompt: t("verify.md"), grade: "npm test" });
  if (!check.passed) await run.gate("needs-human", { show: [check.artifact("report.md")] });

  await run.gate("merge-approved");
}
```

The maker never grades its own homework: the verify step runs a different harness and model. The gates fail closed: no decision, no progress. And every prompt, tool call, and decision lands in an append-only ledger you can `grep`, `jq`, replay, and export.

Running it:

```
$ etium run --loop plan-implement "Fix the flaky auth test in ci/"
run 2026-07-30-fix-flaky-auth-k3f9 started

$ etium gates
RUN                              GATE            OPENED   SHOW
2026-07-30-fix-flaky-auth-k3f9   plan-approved   2m ago   PLAN.md

$ etium approve 2026-07-30-fix-flaky-auth-k3f9 plan-approved --note "skip the retry refactor"
decision recorded; run resumed (detached). `etium tail` to follow.
```

Walk away. The run parks at the next gate and consumes zero processes while it waits. `cron` calling `etium tick` is the whole automation story.

---

## Six primitives, four services, nothing else

**Task** — a goal plus acceptance criteria; a markdown file, wherever it came from. **Run** — one attempt; a directory. **Loop** — a program of steps and gates; a code file. **Step** — one headless harness invocation under a budget, fresh context by default. **Gate** — a named pause requiring a human decision, consumed once. **Ledger** — an append-only `events.jsonl`; state is a fold over events, and every other view is a derived projection.

Around them, core provides exactly four services: a supervisor (budgets, stall warnings, kill), git worktrees for parallel runs, crash-only resume (`kill -9` anything; `etium tick` recovers), and a gate inbox. Harnesses plug in through adapters of roughly two pure functions each — build a command, parse a line. Codex, Pi, Claude Code, OpenHands, or any command via `exec`. Surfaces plug the outer world in the same way: the built-in GitHub surface turns issue assignment into runs and `/et` comments into gate decisions, and projects status back — one cron line, any loop.

---

## What etium will never do

The non-goals are the product. Core will never:

- **Call a model.** No API keys, no context management, no prompts library. All intelligence lives in harness subprocesses.
- **Route MCP.** MCP is the inner loop's tool protocol; etium's boundary is a subprocess speaking JSONL. (Exposing *etium itself* as an MCP server — approve gates from any chat agent — is a planned extension.)
- **Ship a workflow DSL.** Loops are code. YAML workflow languages are how orchestrators become 100,000-line projects.
- **Run a server, web UI, daemon, or database.** Files and a CLI. Your state is `grep`-able, `jq`-able, `rsync`-able, and yours.
- **Sandbox.** Etium sets cwd and env; isolation policy is yours (wrap any harness in docker if you want).
- **Be an eval platform.** Traces are first-class, schema-versioned, and exportable to your eval stack — not locked into ours, because there isn't one.
- **Schedule.** Cron exists.
- **Be the fleet coordinator.** No scheduler, queue, or control plane in core — ever. Etium scales by composition: more repos, more machines, each running the same daemonless loop, aggregated through surfaces and derived indexes — projections of the ledger, never a server that owns your state. The one constraint core keeps is precise and deliberate: **one machine per active run** — a run's strict-consistency domain is its single writer under a host-local lock. Across runs and machines there is no coordination to outgrow, because there is no shared mutable state. Anyone can build a fleet view *on* etium; the contract is files.

---

## Principles

- **The ledger is the only source of truth.** GitHub comments, status output, dashboards — all idempotent projections, never read back as state.
- **Fresh context per step.** Continuity lives in files, not conversations. The model forgets; the repo doesn't.
- **Gates fail closed, decisions consume once.** A human decision is an event like any other — attributed, durable, replayable.
- **Least environment per step.** Agent-facing steps run credential-free; publication credentials live in separate, etium-controlled steps.
- **Crash-only.** Any process may die at any instant. Recovery is a fold and a resume, not a heartbeat and a watchdog.
- **Small enough to read.** Core ≤ ~3,000 lines, each adapter ≤ ~300, each reference loop ≤ ~150 — budgets enforced in CI and published in the README.

---

## Compared to

**Vendor loops** (`/goal`, `/loop`, Automations): excellent inner-loop persistence, but single-vendor, single-session, and the state is theirs. Etium treats them all as interchangeable workers under your gates and your ledger.

**OpenHands**: the best open-source agent platform, and a supported etium harness — but at platform scale (server, GUI, runtimes, cloud) it's a heavy foundation for an outer loop. Etium borrows its best validated idea — event-sourced state with deterministic replay — and none of its weight.

**CI-based controllers**: if you've built an agent pipeline inside GitHub Actions, you've met the failure mode — heartbeat comments, a watchdog that can't run concurrently with the job it watches, labels as a command bus, state smeared across a repo's UI. Etium's predecessor was exactly that system. The design was right; the runtime was wrong. Etium runs the supervisor where the compute is and demotes GitHub to a projection.

**Fleet orchestrators** (Gas Town and kin): the maximal version of this idea — hundreds of agents, coordination as the bottleneck. Etium is deliberately the minimal version: the loop for an engineer and their team of agents, not a Kubernetes for them.

---

## Status

Pre-release; design is public (`DESIGN.md`). Roadmap: **M0** — kernel, `exec`/`replay`/`codex` adapters, the ralph loop, crash-recovery guarantees; from day one, etium is built by a Codex loop running under etium. **M1** — worktrees, token/cost budgets, Pi and Claude Code adapters, the plan→gate→implement→verify loop. **M2** — the built-in GitHub surface (assignment becomes a task, `/et` comments become gate decisions, one status comment as a ledger projection) with the `ai-engineer` loop library on top, OpenHands adapter. **M3** — trace exporters, a static HTML trace viewer, the loop-authoring guide, `etium-mcp`.

MIT licensed. TypeScript, Node ≥ 22.18. `npm i -g @etium/core`.

---

## Lineage

Etium stands on named ideas: Pi's minimal-core, extend-with-code philosophy (pi.dev); Addy Osmani's "Loop Engineering" — the five building blocks, external memory, and the maker/checker split; Aishwarya Srinivasan's loop anatomy — approval gates, stopping rules, and the human context advantage; the OpenHands V1 SDK's production-validated event sourcing; and Geoffrey Huntley's Ralph — the existence proof that the outer loop can be a while loop and a file. Etium's bet is that the outer loop deserves the Pi treatment: a core you can read in an afternoon, and everything else is yours.

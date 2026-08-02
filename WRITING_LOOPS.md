# Writing an Etium Loop

A loop is one ordinary TypeScript file exporting one async function. No DSL,
no YAML, no build step — Node ≥ 22.18 runs your `.ts` directly. This guide
builds a real loop from scratch, then states the rules that make it safe to
`kill -9` at any moment.

The whole vocabulary, before we start:

```ts
run.step(name, opts)   // one headless harness invocation under a budget
run.gate(name, opts?)  // park until a human decides; options default to approve/reject
run.effect(name, fn)   // record a nondeterministic value once, replay it forever
run.abandon(reason?)   // end the run as abandoned
run.params             // strings from --param k=v (and --harness)
run.workspace          // absolute path the steps run in
run.t(file)            // a prompt template, relative to the loop file
```

That is the entire API. Everything else in this guide is convention.

---

## The worked example

The goal: *fix something, but plan first, let a human approve the plan,
verify with a real check, and escalate legibly instead of flailing.* This is
the shape most serious loops share — maker/checker with a human gate.

### 1. Steps are fresh-context harness calls under budgets

```ts
// fix.ts
import type { Run } from "etium";

export default async function fix(run: Run) {
  const plan = await run.step("plan", {
    harness: run.params.harness ?? "pi",
    prompt: run.t("templates/plan.md"),
    artifacts: ["PLAN.md"],
    budget: { wall: "30m" },
  });
}
```

A step spawns the harness with that prompt in the run's workspace, streams
everything it does into the ledger and `raw.jsonl`, and enforces the budget
by killing the process tree. The model gets **fresh context** — continuity
lives in the files it reads and writes, not in a conversation. `artifacts:`
copies the named outputs into the step's directory when it completes, so the
plan survives even if the workspace later changes.

Steps don't throw on failure. They return a value you branch on:

```ts
  if (plan.status !== "ok" || !plan.artifacts.length)
    return run.abandon("no plan produced");
```

### 2. Gates park the run until a human decides

```ts
  const d = await run.gate("plan-approved", { show: [plan.artifact("PLAN.md")] });
  if (d.decision === "reject") return run.abandon("plan rejected");
```

When the loop reaches an undecided gate, the supervisor records `run.parked`
and **exits** — a gate open for three days costs zero processes. `etium
gates` shows what's waiting and on what evidence (`show`). The decision
arrives from anywhere — `etium approve` in a terminal, a `/et` comment via a
surface — and the loop cannot tell the difference; it just sees
`{ decision, note, by }`.

The `--note` on a decision does double duty: it comes back in `d.note`, and
it is automatically appended to the *next* step's prompt. Feedback flows to
the model without the loop doing anything.

### 3. The maker never grades its own homework

```ts
  for (let round = 0; ; round++) {
    await run.step("implement", {
      harness: run.params.harness ?? "pi",
      prompt: run.t("templates/implement.md"),
      budget: { wall: "2h" },
    });

    const check = await run.step("check", {
      harness: "exec",
      command: run.params.check ?? "npm test",
    });
    if (check.passed) return;
```

`exec` runs any command as a black-box step; exit 0 sets `passed`. A step can
also carry `grade: "npm test"` to attach the verdict to itself, but a
separate check step keeps the evidence separate from the actor — the
maker/checker split is loop composition, not a feature.

Note the `for` loop: the second iteration's steps are `implement.1` and
`check.1`. Occurrence numbering is automatic; repeating names in loops is
the normal, supported thing.

### 4. Escalate with declared choices, not a mute failure

```ts
    if (round >= 2) {
      const e = await run.gate("not-converging", {
        options: ["keep-going", "replan", "wrap-up"],
        show: [check.artifacts.at(-1) ?? ""].filter(Boolean),
      });
      if (e.decision === "wrap-up") return run.abandon("stopped after 3 rounds");
      if (e.decision === "replan") return fix(run); // re-enter: plan.1, plan-approved.1, …
      round = -1; // keep-going: three more rounds
    }
  }
}
```

A gate is a question with a declared, finite answer set; `approve`/`reject`
is only the default. The human answers `etium decide <run> not-converging
replan --note "the flaky test is the real bug"` — and that note lands in the
next plan prompt. Re-entering the function is fine: every `run.*` call is
keyed by name *and occurrence*, so the second pass through `plan` is
`plan.1`, remembered independently of `plan.0`.

### 5. Templates

`templates/plan.md`, next to the loop file:

```markdown
Read the task below. Produce PLAN.md: numbered steps, files to touch, the
check that will prove completion ({{check}}).

Task:
{{task}}
```

`run.t()` resolves relative to the loop file first, then the workspace —
your installed templates always win over anything an agent wrote into the
workspace. `{{param}}` interpolates from `run.params`. The template's
*content* is hashed into the step's config digest: editing it mid-run fails
loudly (`DIVERGENCE`) instead of silently replaying stale work.

Personas and shared fragments need no include mechanism — loops are code:

```ts
import * as fs from "node:fs";
const conventions = fs.readFileSync(new URL("./templates/conventions.md", import.meta.url), "utf8");
// …
prompt: conventions + "\n\n" + fs.readFileSync(new URL("./templates/reviewer.md", import.meta.url), "utf8"),
```

A string prompt is content-hashed exactly like a template ref, so the
divergence guarantee survives composition.

### Running it

```sh
etium run "fix the flaky auth test" --loop fix.ts --worktree \
  --param check="npm test -w auth"
etium gates                      # → plan-approved, showing PLAN.md
etium approve <run> plan-approved --note "skip the retry refactor"
etium tail <run>
```

`--worktree` gives the run its own branch (`etium/<run-id>`) in its own
checkout — parallel runs can't collide, and an interrupted step's partial
work is an ordinary uncommitted diff on that branch. Everything the run did
is files under `.etium/runs/<run-id>/`: the ledger, every prompt as sent,
every raw harness stream, every artifact, every decision. `grep` works.

---

## The rules

Replay is the mental model that makes the rules obvious. On every attach the
loop function runs **from the top**; each `run.*` call is looked up in the
ledger by `(kind, name, occurrence)`. Completed calls return their recorded
result instantly; the first unrecorded call executes for real. "Resume" and
"first run" are the same code path — which is why `kill -9` is always safe.

1. **Route nondeterminism through `run.effect`.** Anything that would differ
   between replays — random values, timestamps, an allocated id — must be
   recorded once: `const stamp = await run.effect("stamp", () => Date.now())`.
   Plain code between `run.*` calls must be a pure function of prior results.
2. **No timers, no network, no foreign async in loop code.** Cadence belongs
   to cron, waiting belongs to gates, work belongs to steps. The engine
   detects a loop stuck on a non-etium promise and errors the run.
3. **Don't change a recorded step's config.** Harness, model, prompt
   (template content included), budget, env — a mismatch against the ledger
   is a loud `DIVERGENCE`, never a silent re-run. Renaming the step is the
   escape hatch (`etium redo` arrives in M1).
4. **Steps are at-least-once; write them re-enterable.** A supervisor killed
   mid-step re-executes that step from scratch with fresh context. Have each
   step leave the workspace in a state it can re-enter — under `--worktree`,
   the convention is: commit completed work; partial work is a diff to keep
   or reset.
5. **Branch on values, not exceptions.** `status: error | killed | budget`
   and `passed` are data. The idiomatic response to a bad outcome is a gate.
6. **Keep loop code to milliseconds of glue.** If something is expensive or
   effectful, it is a step or an effect — memoized either way.

---

## Packaging a loop for others

Ship a directory, not a file:

```
fix-loop/
  loop.ts            # the function
  templates/*.md     # every prompt, plain markdown
  README.md          # the contract: params, gates, artifacts
```

The README documents three things — this is the whole interface a user or a
surface needs:

- **params**: name, meaning, default (`check` — the command that proves
  completion; default `npm test`).
- **gates**: name, when it opens, its options, what `show` contains
  (`not-converging`: after 3 failed rounds; `keep-going | replan | wrap-up`).
- **artifacts**: what files appear and what they mean (`PLAN.md` — the
  approved plan of record).

Two conventions keep loops composable with surfaces:

- **Be CLI-complete.** A loop must be fully drivable with `etium approve` /
  `decide` alone, requiring no params a surface would inject. Surfaces are
  skins over the same gates; if your loop only makes sense with one surface
  attached, it is coupled.
- **Choose a publication pattern deliberately.** A standalone loop publishes
  results itself — an `exec` step under `env: { profile: "host" }` running
  `git push` / `gh pr create`, keeping credentials out of agent steps (§9).
  A loop designed to run under a surface publishes nothing: it commits to
  its branch and opens gates, and the surface projects branch → PR → status
  idempotently. Don't mix the two.

Name gate options as imperatives addressed to the agent — `replan`, not
`plan-rejected-state`. The test: does "*agent, `<option>`*" parse as an
order? Those strings are exactly what a human types after `etium decide`
(or `/et`, on the GitHub surface).

---

## Testing a loop

Wire the same fixtures etium's own suite uses: the `replay` harness plays a
recorded raw stream through a real parser — deterministic, token-free.

```ts
await run.step("plan", {
  harness: run.params.harness ?? "pi",
  fixture: run.params.fixture,       // replay only; ignored by real harnesses
  inner: run.params.inner,
  …
});
```

```sh
etium run "test my loop" --loop fix.ts --harness replay \
  --param inner=pi --param fixture=$PWD/fixtures/plan-session.jsonl \
  --param check="test -f PLAN.md" --sync
```

Then the confidence test that matters: start a real run, `kill -9` the
supervisor mid-step, run `etium tick`, and watch the ledger — completed
steps replay from memory, the interrupted step re-executes, the run ends in
the same place. If your loop follows the rules above, this is boring. That
is the point.

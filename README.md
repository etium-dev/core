# Etium

**The outer loop for coding agents.**

Etium is a supervisor for headless coding agents. It owns the outer loop —
tasks, runs, budgets, gates, and the event ledger — and delegates the entire
inner loop (context, tools, model calls) to existing harnesses via thin
adapters. Pi's equation is *agent = model + minimal harness*; etium's is
*team = harnesses + minimal loop*. Etium is the loop.

Status: **pre-release (M0)**. The kernel works — see the test suite for what
that claim means: replay-memoized loops, parking gates, crash-only recovery
under `SIGKILL`, budget enforcement, redaction, harness-owned model auth
([MODEL_AUTH.md](MODEL_AUTH.md)). The `pi` adapter is fixture-validated and
has supervised a real run end-to-end; the `codex` parser is provisional
pending captured fixtures (see below). Interfaces may still move until 0.2.
New here? **[QUICKSTART.md](QUICKSTART.md)** has a runnable hello world, and
**[WRITING_LOOPS.md](WRITING_LOOPS.md)** teaches the loop API with a worked
example.

## Install

```sh
npm install -g @etium/core     # Node ≥ 22.18
```

## Sixty seconds

A loop is a plain TypeScript file. No build step, no DSL:

```ts
// review.ts — plan, wait for a human, implement
export default async function (run) {
  await run.step("plan", {
    harness: "codex",
    prompt: run.t("PLAN_PROMPT.md"),
    artifacts: ["PLAN.md"],
  });
  const d = await run.gate("plan-approved", { show: ["PLAN.md"] });
  await run.step("implement", {
    harness: "codex",
    prompt: run.t("IMPLEMENT_PROMPT.md"), // gate notes are injected here
    grade: "npm test",
    budget: { wall: "2h", tokens: 400_000 },
  });
}
```

```sh
etium run "add retry to fetchUser" --loop review.ts
etium status            # one line per run
etium gates             # what's waiting on you, across all runs
etium approve <run> plan-approved --note "good plan; keep the timeout at 5s"
etium tail <run>        # human-readable event stream
```

The run parks at the gate — no process stays resident. `approve` writes a
decision file and attaches a fresh supervisor; the loop replays from its
ledger, skips completed work, and continues with your note injected into the
next prompt. `kill -9` anything at any time; `etium tick` (cron-safe,
idempotent) reconciles every run back to where it should be. That is the whole
liveness story.

The reference loop is `ralph` (iterate until a check passes) — like every
etium loop library, it is cloned into your repo, where it's yours to edit:

```sh
etium clone-loop ralph
etium run "make the tests pass" --param check="npm test" --param iterations=20
```

(`--loop` defaults to `ralph/loop.ts`; any path works.)

## What a run is

A directory. `task.md` (intent), `events.jsonl` (append-only ledger — the
authority for control flow), `steps/NNN-name.occ/` (prompt, raw harness
stream, artifacts), `decisions/` (gate mailbox), `state.json` (derived cache;
rebuild anytime with `etium rebuild`). Grep it, `jq` it, archive it, replay it.
The ledger schema is versioned JSON with a published JSON Schema and golden
fixtures in [`schema/`](schema/) — that, the on-disk layout, and files-as-API
are the stable surfaces; everything else is implementation.

## Principles

The core never calls a model. One writer per ledger. Gates fail closed and
decisions are consumed exactly once. Budgets kill; stalls only warn. Steps are
at-least-once; completed steps are exactly-once. Least environment per step —
agent steps never see publication credentials. Crash-only: there is no clean
shutdown to get wrong. See [DESIGN.md](DESIGN.md) for the contract and
[DECISIONS.md](DECISIONS.md) for the reasoning.

## Size is a feature

Budgets are enforced in CI (`npm run budget`):

| area | budget (LOC) |
|---|---|
| core (ledger, engine, runner, supervisor, tick) | 3,000 |
| each adapter | 300 |
| the built-in github surface | 450 |
| each shipped loop (ralph, ai-engineer) | 150 |

Current core: ~2,100. If etium needs more than this, it is becoming the thing
it exists to avoid.

## Adapters

`exec` (any command as a step; also the publication vehicle), `replay`
(recorded streams; the test substrate), `pi` (`pi -p --mode json`,
fixture-validated — message, usage, error, and tool shapes grounded in real
captures under [`fixtures/pi/`](fixtures/pi/)), `codex` (`codex exec --json`,
**provisional**). To harden the codex parser and pressure-test schema
neutrality, run [`scripts/capture-fixtures.sh`](scripts/capture-fixtures.sh)
on a machine with the harnesses installed and commit the captures under
`fixtures/`. The Claude Code adapter is next (M1), OpenHands after (M2).

## Surfaces

A surface connects an external system to the same gates the CLI drives:
tasks in, decisions in, projections out, on every `etium tick`. The built-in
**`github`** surface (`etium tick --surface github`) turns `/et` comments
by anyone with Write on the repository into runs and gate decisions — a
`/et <anything>` comment on an issue kickstarts a worktree run of any loop
you configure, an exact `/et <option>` decides the open gate, and freestyle
text is handed to the loop to interpret — and close/merge into run
lifecycle, projecting back a draft PR, one status comment listing the valid
commands, an immutable escalation comment whenever a gate carries a
`reason` (so "why it's stuck" persists and notifies), and `et:*` filter
labels. The deployment acts
as the repository's own gh sign-in (`.etium/gh`, created by `etium
configure`). Configuration is env vars (`ETIUM_GH_REPO`, `ETIUM_GH_LOOP`,
`ETIUM_GH_WORKDIR`, `ETIUM_GH_BASE`) — none of them secrets. Deployment
defaults for loop params — the `harness`, per-persona `harness.<step>` /
`model.<step>`, `rounds`, … — live in `.etium/config.json` under `params`,
merged beneath every run's own values; `etium configure` asks for the
default harness and probes every harness the params reference.
Custom surfaces are modules loaded by path (see DESIGN §10.3).

The **[ai-engineer](ai-engineer/)** loop library is the flagship workload: a
multi-persona debug/design/plan→implement workflow you clone into
your repo (`etium clone-loop ai-engineer`) and adapt. [Tutorial](https://etium.dev/ai-engineer.html).

## License

MIT.

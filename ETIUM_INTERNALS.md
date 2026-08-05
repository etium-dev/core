# Etium Internals

How etium works on the inside, explained for humans. [DESIGN.md](DESIGN.md)
is the contract — terse, normative, the thing implementations are held to.
This document is the guided tour: it explains the same machinery in prose,
section by section, so you can reason about what etium will do without
reading the source. It grows a section at a time.

## State

Etium's entire model of state fits in one sentence: **the truth is an
append-only ledger of events; everything else is input, cache, mailbox, or
work product.** If you hold onto that sentence, every file etium writes and
every recovery behavior it exhibits becomes predictable.

### A run is a directory

There is no daemon and no database. A run — one attempt at one task — is a
directory under `.etium/runs/<run-id>/`, and every piece of its state is an
ordinary file you can `cat`, `grep`, and `jq`:

```
.etium/runs/2026-08-03-fix-the-widget-4k2K/
  task.md            # the intent — what this run is an attempt at (input, written once)
  loop.json          # the configuration: loop module path, params, workspace (written once)
  events.jsonl       # THE LEDGER — append-only, the single source of truth for control flow
  state.json         # derived cache of the ledger (disposable; `etium rebuild` regenerates it)
  decisions/         # the gate mailbox — pending human decisions, consumed exactly once
  steps/001-plan.0/  # one directory per step attempt: prompt.md exactly as sent,
  steps/002-check.0/ #   raw.jsonl(.zst) exactly as received (redacted), stderr.log, artifacts/
  supervisor.log     # stdout/stderr of the supervisors that ran this run
  lock               # the single-writer lock: pid + host, liveness-checked
```

Two more locations complete the picture: `.etium/worktrees/<run-id>` holds
the run's git worktree when it has one (the *work product* lives in git —
on the run's own branch — never inside etium's files), and
`.etium/surfaces/<id>.cursor` holds each surface's opaque progress marker.

Each file has exactly one role. `task.md` and `loop.json` are **inputs**:
written at creation, never touched again. `events.jsonl` is the **truth**.
`state.json` is a **cache**. `decisions/` is a **mailbox**. `steps/` is
**evidence** — the exact prompts and raw streams, kept forever. The
workspace is the **work product**, which etium deliberately does not treat
as state at all: an agent may write anything there; only the ledger says
what actually happened.

### The ledger: events, not status

`events.jsonl` is a sequence of enveloped events — `{v, run, seq, ts,
type, data}` — with a versioned JSON Schema and golden fixtures in
[`schema/`](schema/). The event types are the complete vocabulary of things
that can ever be true about a run:

- `run.created` — the birth certificate: task hash, loop path, params,
  workspace, and (for worktree runs) the branch and the base commit sha.
- `supervisor.started`, `run.interrupted` — attach bookkeeping: who picked
  the run up, and the observation that a previous holder died unclean.
- `step.started`, `step.activity`, `step.completed` — one agent invocation:
  its configuration digest, the parsed highlights of its stream (messages,
  tool calls, token usage), and its outcome (`ok | error | killed |
  budget`, plus `passed` when something graded it).
- `gate.opened`, `gate.decided` — a question with a declared, finite set of
  answers, and the human's answer (with who, via which surface, and an
  optional note).
- `effect.recorded` — a nondeterministic value (a timestamp, a random id)
  captured once so it can be replayed forever.
- `budget.warning`, `budget.exceeded` — enforcement, not decoration: an
  exceeded budget names the kill it caused.
- `run.parked`, `run.completed` — terminal punctuation: parked means
  "waiting on humans, no process resident"; completed carries `done |
  abandoned | superseded | error`.

Notice what is *not* here: there is no "status" event, no mutable record
that gets updated in place. Status is never stored — it is **derived**.

### The fold: deriving state from the truth

To answer "what state is this run in?", etium reads the ledger from the
top and *folds* it: `run.created` makes the state `created`;
`supervisor.started` makes it `running`; `run.parked` makes it `parked`;
`run.completed` ends it. Along the way the fold accumulates a memo table
of every completed step, gate, and effect — keyed by **(kind, name,
occurrence)**, so the second time a loop runs a step named `implement` it
is `implement.1`, remembered independently of `implement.0` — plus the set
of gates opened but not yet decided, and running totals of tokens and
cost.

The fold is deterministic and total: any prefix of a ledger folds to a
valid state. That one property is why crashes are boring — a ledger that
stops mid-story still folds; the state is simply "the story so far."
`state.json` is nothing but the fold's result written down so `etium
status` doesn't re-read long ledgers; it carries no authority, and
`etium rebuild` regenerates it from scratch whenever you doubt it.

### Changing state: one writer, two doors

At most one process may append to a ledger at a time: the **supervisor**
that holds the run's `lock`. The lock file records pid and host, and
liveness is *checked*, never assumed — a lock whose process is dead is
stale, and the next supervisor takes over after appending
`run.interrupted` as an honest note that its predecessor died unclean.
There is no clean-shutdown path to get wrong; taking over from the dead is
the normal code path, exercised on every recovery. This is what
"crash-only" means in practice: `kill -9` at any moment leaves nothing to
repair, because repair *is* the ordinary startup sequence.

Everything that wants to change a run's state goes through one of two
doors:

1. **The supervisor appends events** as the loop executes: steps start and
   complete, gates open, budgets fire. Nothing else ever writes to
   `events.jsonl`.
2. **Humans (and surfaces) write to the mailbox.** `etium approve`,
   `etium decide`, or a surface command like a `/et plan` comment does not
   touch the ledger. It writes a small file into `decisions/`. The next
   supervisor to attach consumes it: it validates the decision against the
   option set recorded in that gate's `gate.opened` event — the ledger is
   the authority on what answers exist, so invalid decisions are refused,
   never guessed at — appends `gate.decided`, and deletes the mailbox
   file. Consumed exactly once, validated against recorded truth.

That's the entire write model. `tick` — the reconciler behind cron, the
LaunchAgent, and `etium watch` — creates no state of its own; it looks at
every run, and any run whose fold says `running` but whose lock is dead
gets a fresh supervisor attached. Cadence lives outside (a scheduler);
truth lives in the ledger; the reconciler just closes the gap between
them.

### Replay: how a run continues

When a supervisor attaches — first run and crash recovery are the same
code path — it runs the loop function **from the top**. Every `run.step`,
`run.gate`, and `run.effect` call is looked up in the fold's memo table by
its (kind, name, occurrence) key. Already-completed calls return their
recorded results instantly, without executing anything; the first call
with no recorded result executes for real. "Resuming" is therefore not a
special mechanism — it is replay hitting memos until it reaches the edge
of history, then continuing.

Two guarantees keep replay honest:

- **Completed steps are exactly-once; interrupted steps are
  at-least-once.** A step that recorded `step.completed` never re-executes.
  A step that was mid-flight when the supervisor died re-executes from
  scratch — and gets its own fresh `steps/` directory, so the first
  attempt's raw stream is preserved, never overwritten.
- **Divergence is loud.** Each `step.started` records a digest of the
  step's full configuration — harness, model, the *content* of its prompt
  (templates included), budgets, env. On replay, if the current code would
  run that step differently than the ledger recorded, etium refuses with a
  `DIVERGENCE` error rather than silently pretending the old result came
  from the new configuration. History cannot be edited, only extended.
  Runs are hermetic against this by construction: creation snapshots the
  loop into the run directory, and replay executes the snapshot (ADR-036).

Nondeterminism gets the same treatment in miniature: a loop that needs a
timestamp or a random id records it once through `run.effect`, and replay
returns the recorded value forever after. The rule of thumb for loop
authors follows directly: everything between `run.*` calls must be a pure
function of prior results, because it will run again on every attach.

### What is deliberately not state

The **workspace** is the agent's scratch space and the work's home, but
etium never reads it to decide anything — continuity for the *model* is
files in the workspace (each step gets fresh context and reads what
earlier steps left behind); continuity for *control* is the ledger alone.
The **git branch** of a worktree run carries the deliverable; surfaces
project it (branch → draft PR) but etium's decisions never depend on
parsing it. **Caches** (`state.json`) can be deleted freely. **Surface
projections** — the status comment on an issue, the labels — are
write-only renderings of the fold, rewritten idempotently and never read
back; deleting them costs a tick of cosmetics, nothing more. And there is
no global registry anywhere: the `.etium/` directory next to your repo *is*
the installation, and archiving a run is `tar` on a directory.

One consequence is worth internalizing because every recovery story rests
on it: since the ledger is the only truth and appending is the only write,
the set of possible corruptions is tiny. A half-written last line of
`events.jsonl` (a crash mid-append) is detectable and ignorable; everything
before it still folds. There is no state to become inconsistent *with* —
no database to drift from the files, no daemon memory to drift from the
disk. What you can read with `cat` is all there is.

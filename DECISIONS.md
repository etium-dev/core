# Decisions

Architecture decision records. DESIGN.md says *what* the contract is; this file
says *why*, so that anyone — human or agent — working from the repo alone has
the reasoning, not just the rules. Amend by appending; superseded ADRs stay.

---

## ADR-001 — Implementation language: TypeScript on Node ≥ 22.18; contracts stay language-neutral

**Decision.** Core, CLI, adapters, and loops are TypeScript/JavaScript on
Node ≥ 22.18. Every stable surface — the ledger schema, the on-disk layout,
files-as-API — is JSON and files, never TS types.

**Why.** (a) Loops are code, and loop authors are the users: TS is the language
of the harness ecosystem (Pi extensions, OpenHands SDK bindings, Claude Code
hooks), so loop authors bring existing fluency. (b) Node ≥ 22.18 strips types
natively: a user's `loop.ts` runs with zero build step, which is the Pi-grade
onboarding experience we want. (c) Because the contracts are JSON + files, a
Rust or Python reimplementation of the supervisor could read the same runs;
the language choice is an implementation detail, not lock-in. Bundled loops
ship as `.js` only because Node refuses to type-strip inside `node_modules`;
user loops in a project can be `.ts`.

**Rejected.** Go/Rust (better daemons, worse loop-authoring story; and there is
no daemon — see ADR-003). Python (weaker process supervision ergonomics, and
the harnesses' own tooling skews TS).

---

## ADR-002 — Loop API: plain async function, replay-memoized, with divergence detection

**Decision.** A loop is `export default async (run) => { … }`. On every attach
the function runs from the top. `run.step` / `run.gate` / `run.effect` calls
are keyed `(kind, name, occurrence)`; keys already completed in the ledger
return recorded results without executing; new keys execute and append. A step
whose recorded config digest differs from the replayed call fails loudly
(`DIVERGENCE`) rather than silently re-running. Nondeterminism must go through
`run.effect`. Loops must not use timers, network, or foreign async; the engine
detects a loop stuck on a non-etium promise and errors out. Gates park
naturally: an undecided gate is a promise that never resolves in this process,
and when nothing else is active the supervisor records `run.parked` and exits.

**Why.** The alternative was resumable coroutines (generators yielding
commands), which are more "honest" about suspension but push every loop author
into an alien style and make composition (helper functions, `Promise.all`)
painful. Replay-memoization keeps loops looking like ordinary scripts —
`await run.step(…)` — while the ledger, not the process, is the source of
truth. This is the Temporal/Restate model reduced to one file and no server.
The known cost is replay divergence when loop code changes mid-run; we chose
detection-and-loud-failure over cleverness. Occurrence counters make loops in
`for` loops work without manual key management. Notes from gate decisions are
runtime *input*, not loop *config*, so they are excluded from the digest. Template
prompts hash the template file's *content* into the digest, so editing a
template mid-run diverges loudly instead of silently replaying stale work.

---

## ADR-003 — Daemonless: parked runs, detached supervisors, idempotent `tick`

**Decision.** No resident service. A supervisor process exists only while its
run is active; it exits on park and on completion. `etium approve` writes a
decision file into the run's mailbox and spawns a detached supervisor (or lets
a live one ingest it). `etium tick` reconciles everything reconcilable — stale
locks become `run.interrupted` and get resumed; parked runs with pending
decisions get supervisors; live runs are skipped — and is safe from cron at
any frequency. `etium watch` (M1) is sugar over tick.

**Why.** A daemon is the single biggest operational tax in this category
(installation, restarts, logs, "is it running?"), and multi-day human-gated
runs mean the steady state is *nothing happening*. Crash-only design (ADR-002's
replay + the lockfile protocol) makes "just attach again" correct, so liveness
can be someone-runs-tick rather than something-stays-up. The known cost:
sub-second reaction to external events requires a tick source; that is an
acceptable trade for a tool whose gates wait hours anyway.

---

## ADR-004 — JSON + JSONL + files everywhere; dual retention (ledger vs raw)

**Decision.** All durable state is files. The ledger (`events.jsonl`) is
append-only JSON Lines, one envelope per line, fsync'd per append, torn final
lines truncated on open; it is authoritative for *control flow* and is never
garbage-collected. Each step's full harness stream is kept verbatim (redacted)
as `raw.jsonl(.zst)` with its sha256 recorded in the ledger; raw is
authoritative for *content* and prunable by policy (`etium gc`, M1). Everything
else — `state.json`, future SQLite indexes — is a derived projection,
rebuildable with `etium fold`.

**Why JSONL and not something richer.** These surfaces are data/wire, not
config: append is one line + fsync; recovery after `kill -9` is "truncate the
torn tail"; corruption is localized to a line; the 3 a.m. debugging story is
`grep`/`jq`/`tail -f`, no tooling required; every harness we adapt already
emits JSONL, making the narrow waist N adapters + M consumers instead of N×M.
SQLite was rejected *as the contract* (opaque to diffs and greps, single-writer
semantics reimplemented anyway, schema migrations become API breaks) but is
welcome *as a derived index*. Binary formats fail the greppability test;
YAML/TOML are config formats, not event streams. Conventions: string IDs,
integers < 2^53, RFC 3339 UTC timestamps, no binary payloads (pointers +
hashes), unknown fields ignored, envelope `v` + JSON Schema + golden fixtures
(`schema/`).

**Why dual retention.** Summaries in the ledger keep it small enough to keep
forever; raw keeps full fidelity for replay/debugging/mining while it is
worth its disk. `RawRef {file, line}` ties every summary back to its evidence.

---

## ADR-005 — M0 adapters: exec + replay + codex-first; fixture-first schema validation

**Decision.** M0 ships three adapters. `exec` (any command as a black-box
step) is the interface floor and the vehicle for publication steps under the
`host` env profile. `replay` (recorded raw streams played through a real
parser) makes the entire test suite deterministic and token-free. `codex`
(`codex exec --json`) is the first real harness; its parser is **provisional
until validated against captured fixtures** (`scripts/capture-fixtures.sh`).
During M0 we also capture Claude Code and Pi fixtures — before their adapters
exist — to pressure-test that the activity/usage schema is genuinely
harness-neutral rather than codex-shaped. Pi and Claude Code adapters land in
M1, OpenHands in M2.

**Why codex first.** It is the harness the dogfooding loop will drive (M0 exit
criterion: etium develops etium under a codex ralph loop), it has a clean
headless JSON mode, and its flags are pinnable at fixture-capture time.

---

## ADR-006 — Single package `etium` now; workspace split deferred

**Decision.** One npm package, `etium`, containing core, CLI, adapters, and
bundled loops, with LOC budgets enforced per area by `scripts/loc-budget.mjs`
in CI (core ≤ 3,000; adapters ≤ 300 each; bundled loops ≤ 150 each). The
monorepo/workspace layout sketched in DESIGN §12 is deferred until a second
independently-versioned artifact actually exists (e.g. `@etium/mcp`).

**Why.** npm does not allow parking a name; claiming `etium` requires
publishing something real, and one coherent package is the strongest possible
claim. A workspace split today would add packaging surface with zero users on
the other side of it. This supersedes the literal directory tree in DESIGN §12
(amended there); the budgets — the part of §12 that is contract — are
unchanged and enforced.

---

## ADR-007 — Model auth: harness-owned, adapter-declared passthrough, two-tier preflight

**Decision.** Model auth is delegated to harnesses entirely — etium never
stores, prompts for, refreshes, or brokers a model credential (the position
and its evidence are in `MODEL_AUTH.md`; this ADR records the mechanism).
Four pieces:

1. **Declaration.** `HarnessAdapter` gains an optional, inert `auth` field:
   `env` (var names the harness consumes for model credentials), `check`
   (a cheap, non-interactive command; exit 0 = authenticated), `remedy`
   (the harness's own fix, printed verbatim). Adapters stay two pure
   functions plus data; core acts on the declaration, adapters never read
   the environment themselves. `exec` and `replay` declare nothing, which
   keeps the deterministic test substrate credential-free.
2. **Passthrough.** Under the `agent` profile, `resolveEnv` copies each
   declared name present in the host env into the step env — inherited at
   spawn time, stored nowhere. Precedence: explicit `env.add` > declared
   passthrough > profile allowlist. Every passed-through value joins the
   redaction secret list *unconditionally* (by declaration, not the
   name-pattern heuristic). `HOME` stays on the allowlist so store- and
   keychain-based harness auth keeps working. Grader output is redacted with
   the same secret list before `grade.txt` is written — the grader inherits
   the step env, and `env` piped to a grader must not become a plaintext
   secret in an `rsync`-able run directory.
3. **Ledger.** `step.started` gains an additive, informational
   `authEnv?: string[]` — the names actually passed through, never values.
   It is excluded from the config digest: host-env presence is runtime
   input, exactly like operator notes (ADR-002), so an attach on a
   differently-populated environment (another machine, an unset var) must
   never throw DIVERGENCE. Additive within schema v1 — consumers ignore
   unknown fields; `schema/events.schema.json` and golden fixtures update
   in the same change as `types.ts`.
4. **Preflight, two-tier.** Creation-time: `etium run` checks the harnesses
   it can resolve (from `--harness`/params) *before* appending `run.created`;
   on definitive failure it creates nothing, exits non-zero, and prints the
   remedy. Authoritative: the supervisor runs the declared check on each
   step's memo miss, *before* `step.started` is appended, cached per harness
   per attach. Definitive failure (non-zero exit, missing binary) ends the
   run `error` with the remedy in the summary; because nothing was appended
   for the step's key, no occurrence is consumed and nothing is memoized —
   after the operator authenticates, resume replays to the identical point
   and the step runs for the first time. Indeterminate results (timeout)
   proceed with a stderr warning: unattended `tick` resumes must never block
   on a flaky check, and a truly broken credential fails legibly one step
   later. To make retry-after-fix real, `supervise` re-attaches runs that
   completed `error` (only `done`/`abandoned`/`superseded` are terminal to
   it) — the explicit-human path via `etium resume` — while `tick` keeps
   skipping all completed runs, so errors are never retried unattended.
   `etium doctor` (M1) renders the same checks read-only and exits 0 —
   informational; the preflights are the gates.

**Why.** The full argument is `MODEL_AUTH.md`; the load-bearing points: the
auth-baggage floor (storage, refresh, precedence) is irreducible only for
things that call models, and etium uniquely doesn't; subscription OAuth —
the auth mode users actually run — is legally and technically tied to each
harness and cannot be brokered; and the OpenHands reference implementation
shows what brokering grows into (plaintext stores, echo-prevention, rotation
footguns, unresolved credential-scoping issues). Delegation's one real
weakness is *illegible failure*, so the mechanism spends its entire budget
on legibility: declared (not accidental) passthrough, names in the ledger,
remedies printed verbatim, and a check that runs before anything is
recorded. Creation-time preflight alone was rejected as authoritative
because harness choice is runtime data (`run.params.harness ?? "codex"` in
ralph) — statically undecidable, so the pre-spawn check carries the
guarantee. Failing *before* `step.started` was chosen over a
`status: "auth"` step outcome because a recorded failure burns the
`(kind, name, occ)` memo key and hands the loop a failure value it may
branch on forever; an un-recorded failure makes "fix auth, resume" the
normal crash-only path.

**Rejected.** An etium credential store / `etium login` / secret-valued
config (banned in `MODEL_AUTH.md`; imports the brokering baggage without its
justification). Recording preflight failure as a ledger event (a run that
never started has nothing to record; the error summary on `run.completed`
suffices when the supervisor was already attached). Including `authEnv` in
the config digest (spurious DIVERGENCE on env changes between attaches).
Gating passthrough-value redaction on the `SECRET_NAME` heuristic (a var is
a credential *by declaration*; the heuristic exists for undeclared `host`
vars). A loop-level harness-declaration surface for creation-time preflight
(new API surface to make a best-effort check slightly less partial — the
pre-spawn check already carries the guarantee). Driving the OpenHands
agent-server (expects LLM credentials in-band — the rejected brokering;
the adapter drives the headless CLI, which reads its own settings store).

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

---

## ADR-008 — Gate answers are declared option sets; binary is the default, not the definition

**Decision.** `run.gate(name, { options?: string[] })` — a gate is a question
with a declared, finite answer set. `gate.opened` records the set;
`gate.decided.decision` is the chosen element; gates that declare nothing get
`["approve", "reject"]`. Decisions are validated fail-closed against the set
**as recorded in the ledger** (loop code that drifts after opening produces a
warning; the ledger governs). CLI: `etium decide <run> <gate> <option>`, with
`approve`/`reject` as sugar for the default set. Pre-approval errors loudly
if the named gate's options do not include `"approve"`. Single-choice only;
the note remains the free-text channel alongside any decision.

**Why.** Two structural facts fix the answer-space a gate can offer. Loop
code is deterministic TypeScript: it can only branch on values from a closed
set. And every loop has an LLM downstream: free-form human input needs no
structure because its consumer is the next prompt — that is what the note
already is. So the consumable answer types are exactly {element of a declared
enum} ∪ {free text}, and the old binary gate was the hardcoded special case
of the former. The delivery media agree: CLI verbs, GitHub labels, Slack
buttons, MCP tool enums — every cheap human-decision channel is enum+text
shaped. The need is general, not routing-specific: the predecessor system's
escalation contract required listing "available choices and the exact label
needed to continue," and ralph's iteration guard, needs-human gates,
judge-panel picks, and budget-breach recovery all want declared choices.
Recording the set in `gate.opened` makes the question auditable, gives
surfaces a closed set to render, and makes validation authority unambiguous
after loop edits.

**Rejected.** N binary gates raced (unchosen gates dangle open — inbox
pollution, broken consumed-once semantics; fixing that needs a stranger
withdraw-gate primitive). A separate `run.choice()` primitive (identical
semantics, twice the surface: two pause primitives, two event types, a split
inbox). Arbitrary JSON payloads with per-gate schemas (loops can't safely
consume arbitrary shapes; labels can't render forms; ledger legibility drops
to blobs; no workflow in scope needs it). Multi-select (its consumer is
always the model, so the note covers it; the predecessor treats multiple
simultaneous commands as an error — hard-won evidence that single-choice is
the right human contract).

---

## ADR-009 — Surfaces: pull-based poll/project modules driven by tick; commands are comments, not labels

**Decision.** A surface is a user-supplied module (`etium tick --surface
<path>`, loaded like a loop) implementing `{ id, poll(ctx), project?(run) }`.
`poll` receives an opaque persisted cursor plus read-only `RunView`s and
returns new tasks and gate decisions; `project` idempotently pushes run state
out and is never read back. Core creates at most one run per task
idempotency `key` (recorded as reserved param `surface.task`), validates
decisions fail-closed against the gate's ledger-declared options before
writing the mailbox with `via: <surface id>`, and orders each tick
poll → reconcile → project so a decision polled this tick resumes its run
this tick. A broken surface is reported and skipped; reconciliation never
waits on one.

**Why pull + cursor + keys.** Push (webhooks, servers) needs something
resident — the non-goal. Pull from cron-driven tick matches ADR-003's
liveness story and makes offline honest: nothing updates, nothing lies, the
next tick catches up. At-least-once with an opaque cursor is the simplest
correct contract: the cursor advances after actions land, and redelivery is
absorbed by the task-key check and by decisions failing closed on
already-decided gates — idempotency in the actions, not in delivery
plumbing. Task keys are the triggering external event's id, so "new attempt"
is naturally "new event, new key" with no attempt-counter machinery.

**Why commands are comments, not labels (the predecessor's core flaw).**
Labels did three jobs — command channel, status display, state storage — on
GitHub's one mutable-state primitive: a shared, unversioned bitfield with
last-writer-wins, no compare-and-swap ("consume the label" is a
read-then-write race), no payload (forcing the comment-before-label ordering
trap), and no attribution without a second read path (the timeline). Status
labels as mutable flags are why the watchdog apparatus existed. GitHub's
event primitive is the comment: append-only, attributed, ordered, carries
option + note in one atomic unit, consumed by cursor advance with no
mutation. So: `/et <option> [note]` comments in (slash form, not @-mention —
short handles like @et belong to real users who would be pinged), one
idempotently-rewritten status comment out (listing the currently-valid
commands), labels reduced to a write-only filter-decoration set
(`et:working`/`et:waiting`/`et:blocked`) that nothing ever reads back, and
assignment/merge/close consumed as timeline events under the same cursor.
Option strings must read as imperatives addressed to the agent (triage,
debug, design, plan, implement; approve/reject/stop) — "does `/et <option>`
parse as an order" is the naming test.

**Rejected.** Config-as-code for surface registration (the cron line naming
`--surface` paths IS the registration; no new config machinery — §14 open
item 1 stays open on its own merits). Surfaces in core (the GitHub surface
is policy-heavy and ships as a package; core carries only the interface).
Push/webhook ingestion in core (a tiny external trigger can always call
`etium tick`). Labels as commands (above). Per-run cursors managed by core
(the cursor is opaque precisely so surfaces encode their own).

---

## ADR-010 — Worktree per run: explicit opt-in, one branch per attempt, no auto-cleanup

**Decision.** `etium run --worktree [--base ref]` (and `SurfaceTask.worktree`)
gives a run its own git worktree at `<base>/worktrees/<run-id>` on a fresh
branch — default `etium/<run-id>` off `HEAD`, both overridable (surfaces name
attempt branches like `etium/issue-7-attempt-<n>`). Mutually exclusive with
`--workspace`. The worktree is created *before* the run directory: it is the
one step that can fail for external reasons, and an aborted creation must
leave no half-made run behind. `run.created` records `{ repo, branch, base }`
so surfaces can open PRs from the branch. Completed and abandoned runs keep
their worktrees; pruning is `etium gc` policy (M1), not a lifecycle side
effect.

**Why.** One branch per attempt is the predecessor's hard-won rule —
abandoned work must never block later attempts — and worktrees make parallel
runs isolated by construction while sharing one object store (a clone per run
costs full-repo disk and setup time for nothing). Explicit opt-in rather than
auto-detection of a git cwd: `--workspace .` (work directly in a checkout,
QUICKSTART's flow) and worktree-per-run are both legitimate; silently
switching behavior on repo detection would surprise exactly the first-run
user. No auto-removal on completion because the human's next act is usually
to inspect, merge, or salvage the branch — deletion is a retention policy,
and retention lives in `gc` (§4).

**Rejected.** Auto-worktree when cwd is a git repo (behavioral surprise;
breaks the plain-workspace flow). Clone per run (disk, time, no isolation
gain over worktrees). Worktree removal on run completion (destroys the thing
the human is about to review; gc owns retention). Recording the worktree
only in loop.json (surfaces read the ledger; run.created is the durable,
greppable record).

---

## ADR-011 — The ai-engineer package: the extensibility proof, outside core

**Decision.** The predecessor workflow ships as `ai-engineer/` — `loop.ts`
(the whole 18-state machine as one route loop with converge stages),
`templates/` (seven personas under the WRITING_LOOPS conventions),
`github.ts` (an ADR-009 surface), and a README carrying the
params/gates/artifacts contract. It lives outside core with its own LOC
budget rows (loop ≤ 150, surface ≤ 450). The loop is CLI-complete — the
test suite traverses the full graph with mailbox decisions and scripted
`exec` steps, no surface loaded — and publication-free: it commits to its
branch and opens gates; the surface projects branch → draft PR → status
comment → decoration labels, all idempotent, never read back (a PR *is* a
projection — the predecessor's invariant 11 already treated PR bodies as
untrusted). §9 now names both sanctioned publication patterns.

**What building it forced into core** — the honest measure of the
extensibility test: `run.task` (loops could not read the task, one of the
six primitives — an API omission, not a feature); the `abandons` channel
(observed lifecycle facts must terminate runs; decisions can't and
shouldn't); and a one-line bug fix (tick forwarded every SurfaceTask field
except `worktree`, caught by the package's own tests). Everything else —
N-way routing, fail-closed option validation, attempt branches, cursor
consumption, the status projection — ran on primitives that already
existed. Notable emergent simplification: the predecessor's "no
`ai-implement` without an accepted plan" guard is now just the declared
option set — `implement` isn't offered until a plan converged, so the rule
enforces itself.

**Mechanics worth recording.** Personas compose in code (conventions +
persona + `{{task}}`/`{{stage}}` interpolation), keeping the digest
guarantees. `cmd.<step>` params are the dry-run hook: under `--harness
exec` they script any step (real adapters ignore `command`), which is what
makes the graph testable token-free and gives operators a walkthrough mode.
The surface's config is env vars with no secret values — GitHub auth stays
`gh`'s, model auth stays the harness's (MODEL_AUTH.md); the same cron line
deploys mode A (you, your machine) and mode B (a bot account's machine)
with zero code difference.

**Rejected.** A workspace split for the package (ADR-006 stands until it is
independently versioned; a directory is enough). Surfaces or personas in
core. Labels as anything but write-only decoration (ADR-009). A suspension
primitive (abandon + reassign-as-new-attempt covers Suspended, with
branches preserving the work).

---

## ADR-012 — The github surface moves into core; ai-engineer becomes pure content

**Decision.** `src/github.ts` is a built-in surface, resolved by name
(`etium tick --surface github`, mirroring builtin-loop resolution; paths
still load custom surfaces). `ETIUM_GH_LOOP` is required — the composition
point between core plumbing and whichever loop library the operator points
it at. The draft-PR trigger is loop-agnostic: `run.created.worktree` now
records `baseSha` (the resolved base commit), and a PR opens once the
branch head differs from it — "has commits to review" — replacing the
ai-engineer-specific artifact-directory check. The `ai-engineer/` package
is thereby pure content: a loop and templates that users copy into their
repos and adapt. This supersedes ADR-011's placement of the surface; the
rest of ADR-011 stands.

**Why.** The two halves want opposite distribution models. Loops and
personas are content — copy-and-own is correct, adaptation is the point,
divergence from upstream is healthy. The surface is plumbing — nobody
should edit it, everybody wants fixes, and copied plumbing rots; in core it
ships compiled in the npm tarball (`--surface github` works straight from
`npm install`, which a copied `.ts` never could from node_modules) and
upgrades with the package. It also completes a symmetry: core ships harness
adapters for the inner world behind a neutral interface; the github surface
is the same thing for the outer world. The §11 non-goal was never "no
GitHub code" — it is "GitHub is never authoritative state", which the
surface upholds by construction (projections out, events in, nothing read
back).

**Rejected.** Keeping the surface in the package (plumbing rots when
copied). A plugin/registry mechanism for third-party surfaces beyond
load-by-path (a path is a registry). Per-loop PR triggers (the baseSha
check is universal; GitHub refuses zero-commit PRs anyway).

---

## ADR-013 — Loop libraries travel in the tarball; `clone-loop` copies them out

**Decision.** Bundled loop libraries (today: `ai-engineer`) ship as data
inside the npm tarball, and `etium clone-loop <name> [--into dir]` copies
one into the user's repo — refusing to overwrite, appending `.etium/` to
the receiving `.gitignore`, and printing the next step. Bare `etium
clone-loop` lists what's bundled. A cloned library is the user's to edit;
upgrading is a fresh clone into a scratch directory and a diff, never an
auto-merge. Library source files import types from `@etium/core` (truthful
at their destination; erased at runtime; resolved in-repo via a tsconfig
paths mapping). The CLI verb `fold` is renamed `rebuild` in the same
release — the help text had always defined it with that word; "fold" stays
in prose as the event-sourcing term it is.

**Why.** Copy-and-own content wants the shadcn distribution model, not a
dependency: node_modules is precisely where adaptable content must not
live (unеditable by convention, clobbered by updates, and Node refuses to
type-strip `.ts` there — copying *out* is fine). Bundling in the tarball
makes npm the only distribution channel — versioned with the release,
integrity-checked, offline after install — and collapses the stranger's
path to `npm install -g @etium/core && etium clone-loop ai-engineer`. The
verb names its object because the bare verbs (`init`, `vendor`, `add`)
were judged too abstract: `clone` imports the right git-shaped intuition —
your own copy, nothing syncs unless you do it deliberately.

**Rejected.** `npm install @etium/ai-engineer` (a dependency, not a
clone). Git submodules (resist local edits). A loop-library registry
(a third-party library is a repo you `degit` — documented escape hatch,
not core machinery). Auto-update/merge of cloned libraries (violates
copy-and-own; diff-and-take is the contract).

---

## ADR-014 — `etium init`: checks, then questions, then apply — in the binary

**Decision.** Setup lives in etium, not in prose: `etium init` first checks
the machine (Node floor, git, repository, `gh` + its authenticated
identity, each installed harness's auth via the adapter declarations) and
stops with a `needs <thing> — run: <exact command>` line per unmet
dependency; when checks pass it asks the setup questions — loop library,
GitHub wiring, commander, acting identity, wake-up — as TTY prompts with
detections pre-filled, or takes every answer as a flag (`--library`,
`--github`, `--trusted`, `--act-as`, `--wakeup`) so an agent that
interviewed the operator in chat runs it non-interactively; then it
applies: clones the library, installs the crontab entry (wake-up `cron`)
or prints it (`print`), and ends with copy-paste next steps. Named `init`,
not `doctor`: it announces a beginning, not an illness — and checks that
exist only inside a setup flow don't need a second verb. This supersedes
the standalone-`doctor` plan (ADR-007's CLI note, the M1 list).

**Why.** Field tests kept finding drift between documented remedies and
the binary — prose instructions age; code ships, versions, and gets
tested. The split that survives: remedies for dependencies that exist
*before* etium (Node, npm, installing etium itself) must stay didactic
prose in AGENT_INSTALL; everything after `etium --version` succeeds is the
binary's job. Choices keep two front-ends over one implementation because
their best UX differs: an agent interviewing in natural language beats a
TTY wizard, and a TTY prompt beats making a human read a doc — but both
feed the same flags.

**Rejected.** A separate `doctor` verb (a second way to run the same
checks; the name pathologizes a fresh machine). A full-setup wizard that
also performs installs (never sudo, never OS installers — remedies are
printed, operators execute). Interactive prompting for agents (flags
exist precisely so nothing prompts).

---

## ADR-015 — install.sh: pi's installer, adapted, npm still the only artifact

**Decision.** `curl -fsSL https://etium.dev/install.sh | sh` is the primary
documented install. The script is pi's installer (pi.dev/install.sh, MIT,
attribution in the header) adapted, not rewritten — it is battle-tested and
we changed as little as possible: package/name/branding, etium's exact Node
predicate (22.18+/23.6+/24+), the locked-install path removed (it depends
on pi's release-metadata API; our plain npm tarball is already the
release-gated artifact), and the epilogue points at `etium init`. What it
does: preflights Node+npm and offers to install Node (Homebrew/apt/apk or
a standalone user-local tarball from nodejs.org, checksum-verified); picks
an npm prefix — the user's own when writable, else `~/.local` — so sudo is
structurally never needed; runs `npm install -g --ignore-scripts
@etium/core`; offers a one-line PATH update with confirmation. Non-TTY
runs proceed with safe defaults. Verified end to end in a sandboxed HOME
against a simulated root-owned prefix, installing the real registry
package into `~/.local/bin`.

**Why.** Field tests kept hitting the two first-contact frictions — the
EACCES/sudo class and the Node floor — and the ecosystem's answers split
into two shapes: Claude Code's (native binaries, signing, notarization,
package repos — a distribution organization) and pi's (bootstrap UX around
the unchanged npm artifact). Pi's shape keeps every release-confidence
property intact because the installer changes *where* npm installs, not
*what* — and copying working MIT code beats days of reimplementation
debugging. The npm command remains documented for healthy setups; agents
keep their classified npm flow.

**Rejected.** Native per-platform binaries (deferred with costs named —
the regime where codex's certificate revocation lives). Keeping pi's
locked-install (needs a release-metadata API we don't run). A from-source
fallback (removed earlier; unchanged). npx (a permanent second path).

---

## ADR-016 — ralph is a loop library like any other; builtin loops removed

**Decision.** The loop library is one convention with no privileged member:
a library is a directory (`loop.ts` + a `README.md` contract, templates
when it has any) shipped inside the npm tarball as copy-and-own content and
delivered by `etium clone-loop <name>`. `ralph` — previously a bare
`loops/ralph.js` resolved by builtin name — becomes `ralph/` (TypeScript at
last, plus the README the authoring guide already mandates), and the
special machinery is deleted: builtin-name resolution in `resolveLoop`,
`bundledLoopsDir()`, and the `loops/` directory. `--loop` takes paths,
period; its default is the path `ralph/loop.ts`, and when nothing is there
the error teaches `etium clone-loop ralph`. `etium init` clones whichever
library is chosen (ralph stays the default choice) and leaves an existing
clone untouched.

**Why.** Two file conventions, two distribution models, and two resolution
mechanisms — for a library of two loops. Every oddity was downstream of
ralph predating the convention (ADR-013, WRITING_LOOPS): the `.js`
requirement existed only because the file executed from `node_modules`;
the missing README under-complied with our own authoring guide; choosing
ralph in init did nothing. Fewer ways, one mental model: loops are
directories you clone into your repo and own. Core got smaller.

**Rejected.** Keeping ralph builtin as the zero-setup default (Enter in
init now copies a visible, stated folder — the menu label is the consent,
and the guided path feels identical). Compiling `ralph.ts` into `dist/` to
keep a builtin (a build artifact between the user and the ~35 lines they
are meant to read). A `--loop ralph` name alias over the clone (a second
resolution mechanism — the thing being deleted).

---

## ADR-017 — commit-ability is core's job; artifact commits are the loop's job

**Decision.** Two guarantees replace one hope. Core: every worktree it
creates can commit — `createRun` applies the spec's `worktree.identity`
(surfaces pass the acting account; the github surface authors as
`<agent>@users.noreply.github.com`) as *worktree-scoped* git config
(`extensions.worktreeConfig`, never the shared repo config), and when no
identity is given and the machine resolves none, sets a fallback so
`git commit` can never die of "tell me who you are". Loops: anything later
stages or surfaces depend on is committed *by loop code* — the ai-engineer
loop runs a guarded `exec` commit step after every persona step (no-op when
clean or outside a git checkout; loud failure otherwise). Around them:
`etium init` prompts for and applies a missing global identity itself
(`--git-name`/`--git-email` for agents — never a copy/paste command), and
the github surface fails poll fast with the remedy when `gh` auth is dead.

**Why.** The first live GitHub run executed a full multi-stage workflow and
produced zero external evidence: the machine had no git identity, every
persona commit died silently, branches never left base, so no PR — while
the dead gh token and a stopped watch muted the rest. Every layer had
trusted something it must guarantee: core trusted the machine, the loop
trusted persona compliance with a prompt instruction, the surface trusted
gh. Prompts are hints; guarantees belong in code. The replay model turns
the fix into the recovery: existing runs resume, memoized stages skip, the
new commit steps execute for work already done, and the branches finally
carry it — no hand-editing of run state.

**Rejected.** Runtime auto-commit after every step in core (can't
distinguish completed from partial work — the loop knows, core doesn't;
WRITING_LOOPS keeps "partial work is a diff"). An init-only identity check
(surface-created runs never pass through init — same lesson as the harness
presence gate). Hand-repairing the affected runs (masks the defect; replay
heals them through the fixed loop instead).

---

## ADR-018 — always-on wake-up is a launchd agent on macOS, cron on Linux

**Decision.** `etium init --wakeup cron` installs the once-a-minute tick
platform-correctly: on macOS, a per-repo LaunchAgent
(`~/Library/LaunchAgents/dev.etium.tick.<hash>.plist`, `StartInterval` 60,
bootstrapped into the `gui/<uid>` domain; idempotent bootout-rewrite-
bootstrap on re-init, retiring any crontab line an older etium installed
for the repo); on Linux, the crontab line as before. Both bake init's PATH
into the scheduled command. `print` mode installs nothing — on macOS it
prints the command and points at re-running init, because writing a plist
into LaunchAgents auto-loads at next login, which is an install, not a
printout. The flag value stays `cron` (docs and the agent interview say
"always-on"). The generators live in `src/wakeup.ts` and are unit-tested;
the suite never invokes launchctl or crontab.

**Why.** The first live deployment ran under macOS cron and authenticated
intermittently: gh stores its token in the login keychain, and cron (like
SSH) executes in a different audit session that cannot read it — ticks
worked only in windows where the GUI context leaked through. Apple's
guidance is launchd for periodic per-user jobs; the Mac CI industry runs
agents in the `gui/` domain for exactly this keychain reason; GitHub's own
runner service uses launchd on macOS. The agent keeps credentials where
gh's security model puts them — the alternative remedy on the table,
`gh auth login --insecure-storage`, moves the token to plaintext, and
etium never instructs users to downgrade credential storage.

**Rejected.** Documenting `--insecure-storage` (the flag's name is the
verdict). A LaunchDaemon (needs sudo; has no session, so the keychain
problem returns). Keeping cron on macOS with unlock workarounds (storing
the keychain password to unlock the keychain is the same problem wearing
a hat). Renaming the flag value (breaks the documented interview and
every existing handoff).

**Limitation, stated plainly.** Agents run while the user is logged in and
resume at login. Truly headless fleets pair this with auto-login (the Mac
CI norm; FileVault requires an unencrypted boot volume for it) — a setup
choice etium documents but does not make.

---

## ADR-019 — `configure` (né `init`): state-aware, re-runnable, with persisted wiring

**Decision.** The setup verb is `etium configure` — renamed from `init`
cleanly, no alias (0.10.0; the first exercise of the 0.x versioning
policy: y bumps only for breaks). It is re-runnable by design: on a
repository that is already configured, an interactive run opens with a
state-aware action menu — re-run setup, install or remove the always-on
wake-up (whichever applies), show status, exit — rendered in the
installer's exact visual language (cyan keys, green constructive, red
destructive, dim neutral). Fresh repositories skip the menu and go
straight into setup; any setup flag means an agent is driving and also
skips it. To make later invocations possible without re-interrogating,
setup persists its non-secret answers to `.etium/config.json` (library,
GitHub repo/trusted/agent/loop). The file is configure's memory, not the
runtime's input: tick and the github surface still read env vars only —
config.json reconstructs the commands configure prints and runs, and
never feeds the runtime behind the operator's back. No secrets ever
(GitHub auth is gh's, model auth is the harness's).

**Why.** "Init" promised a beginning; the verb is actually how state gets
managed for the life of the repository — the first field deployment needed
"add the wake-up later" and "remove the wake-up", and had no way to do
either short of re-answering everything (the wiring lived only in
whatever command line it once rode in on — the same observability gap the
silent-GitHub post-mortem flagged). A menu computed from detected state
turns those into one keystroke, and the persisted wiring is what makes
them possible at all.

**Rejected.** Keeping `init` as an alias (two names for one verb; fewer
ways). Re-asking the GitHub questions inside "install the wake-up"
(re-interrogation as a substitute for memory). Making config.json a
runtime input for tick (hidden coupling; env stays the runtime contract,
12-factor style, and the cron/agent line remains self-contained and
auditable).

---

## ADR-020 — wake-up identity is minted, not derived; artifacts are found by enumeration

**Decision.** Each configured checkout gets a mint-once identity: an
8-hex `id` written into `.etium/config.json` on first `configure` and
preserved across every re-run (re-minting would orphan what the id
names). Wake-up artifacts are named from it — LaunchAgent label
`dev.etium.tick.<sanitized-basename>.<id>` (basename for humans, id as
the tie-breaker), and every scheduled command ends with the inert marker
`# etium:<basename>.<id>`. Four strings are frozen on-machine ABI, so any
future etium can find and remove anything any past etium installed: the
`dev.etium.` label prefix, that label grammar, the cron signature
substring `etium tick --surface github`, and the marker format. Removal
and re-install never trust name recomputation alone: they enumerate by
prefix (macOS) or signature (cron) and match the embedded repo path or
id — sweeping artifacts from older grammars too. Paths are realpath'd
before hashing or matching, so symlink and `/tmp`-alias spellings cannot
fork identities.

**Why.** A pure path-hash label had two failures: humans can't read it
(`launchctl list` full of opaque hex), and its input is unstable — a
moved or renamed repo recomputes a different name and strands the old
agent forever, failing `cd` in the dark. Minted identity survives moves
(configure in the moved checkout reads the same id and finds its own
agent); the basename restores legibility; enumeration plus
self-describing payloads guarantees cleanup even when every naming
convention has changed since installation. The field's first artifact —
a hand-installed agent with a label no formula produces — is exactly
what enumeration-based removal handles.

**Rejected.** Storing a recomputable path-hash in config.json (a cached
copy that drifts on move — duplication, not identity). Pure-basename
labels (two same-named checkouts collide; the second silently steals the
first's plist). systemd-style full-path escaping (reversible but long
and ugly, and unnecessary once payloads are self-describing). Deriving
identity at install time from anything that can change underneath it.

---

## ADR-021 — headless is the first-class path: credentials must be context-free

**Decision.** Setting up and operating etium works 100% over SSH, with no
GUI session anywhere in the path. The principle: **a bot machine's
credentials must be readable from any execution context** — GUI-bound
storage is a per-credential opt-in, never a requirement. Applied:

- **gh sign-in**: when wiring GitHub and gh isn't (verifiably) signed in,
  `configure` offers token sign-in first — it walks the operator through
  creating a fine-grained token scoped to the one repository (Issues, Pull
  requests, Contents), then runs `gh auth login --with-token
  --insecure-storage` with the terminal inherited: the token is pasted
  straight into gh, and etium never sees, stores, or transports it
  (MODEL_AUTH's delegation, applied to GitHub). File-stored (0600), it
  works from ssh, cron, launchd, and the GUI alike. The browser device
  flow remains the interactive alternative; on macOS-over-SSH a
  keychain-held sign-in can be knowingly kept (`unverifiable` is not
  `unauthenticated`). Agents (flags mode) never get an interactive spawn —
  they hard-fail with the exact command for the operator.
- **git pushes**: after any successful sign-in, `gh auth setup-git` routes
  git's HTTPS credentials through gh — otherwise projection pushes hit the
  osxkeychain helper, the same GUI wall one layer down.
- **The wake-up mechanism follows the credential**: file-held gh auth →
  cron (which on macOS runs with nobody logged in — survives reboot to the
  login screen); keychain-held auth → the ADR-018 LaunchAgent, the
  GUI-coupled mode it inherently is. Cron installs verify immediately: one
  tick runs inline and the real verdict (or the surface's error with its
  remedy) prints — from SSH.
- **macOS privacy protection (TCC)**: a repo under ~/Documents, ~/Desktop,
  or ~/Downloads gets background processes blocked pending GUI approval —
  `configure` now says so and steers bot repos elsewhere.
- **Harness auth**: pi's `/login` TUI is terminal-native; codex's remedy
  string now names its headless forms (`codex login --api-key`,
  `OPENAI_API_KEY`). Both store in files — context-free once obtained.

**Why.** The field sequence kept rediscovering one wall in different
rooms: gh worked in Screen Share but not SSH (keychain), ticks worked
from a GUI LaunchAgent but not cron (keychain), configure's gate passed
at the console but failed over SSH (keychain probe). Patching each site
moved the problem; naming the principle removes the class. The earlier
blanket rejection of `--insecure-storage` (ADR-018) was right for a
person's broad OAuth token and wrong for a bot deployment: a one-repo
token in gh's 0600 file is CI-normal storage with a smaller blast radius
than an all-repo token in a keychain.

**Rejected.** Verifying auth "at first tick in the GUI session" (still
assumes a GUI exists — moving the problem). Etium prompting for or piping
the token itself (delegation: gh owns its credential end to end).
Auto-login guidance as the primary answer (it is the workaround for
keychain-mode, not the path). GH_TOKEN in the scheduled command line
(secrets in crontab/plists, and etium becomes the credential handler).

---

## ADR-022 — one identity per deployment; trust is the repository's permission model

**Decision.** The GitHub surface has no configurable identities. The
deployment acts as its own repo-scoped gh sign-in: every etium gh call
runs with `GH_CONFIG_DIR=<checkout>/.etium/gh`, where gh stores the token
in its hosts.yml (file-held via `--insecure-storage` on both the token and
device-flow paths, so nothing ever lands in the shared system keyring; the
machine's personal gh is never read or written). `configure` creates the
sign-in — token pasted straight into gh, hidden input — verifies push
access immediately, and wires a repo-local git credential helper (an empty
first entry silences global helpers like osxkeychain) so projection pushes
authenticate the same way. Who may command is not configured either:
anyone the repository grants Write (checked live per actor against the
collaborator-permission API, cached per poll, fail-closed). Deleted:
`ETIUM_GH_TRUSTED`, `ETIUM_GH_AGENT`, `--trusted`, `--act-as`, the
bot-vs-me question, and config.json's trusted/agent fields — the GitHub
wiring is a repository, a loop, and one pasted token. The wake-up
mechanism returns to a platform constant — launchd agent on macOS (the
platform's blessed scheduler; event triggers like WatchPaths and prompt
post-sleep ticks are its future), cron on Linux — because auth is
file-held either way; both verify with one inline tick at install.

**Why.** A day of field failures was identity multiplication: whose
keychain, whose account is active, which token type for whose repo, which
machine's gh. Two accounts times three storage contexts times two token
types made every setup step a place to be wrong. Scoping identity to the
checkout removes the multiplication: it composes with per-checkout
config.json and the minted id (the deployment is the unit of everything),
two checkouts of one repo hold separately revocable tokens, and mode A vs
mode B collapses into "whose token you paste." Delegating trust to Write
keeps authorization in the one place it is already administered — GitHub
grants nothing a Write-holder lacks, since they could push directly and
the engineer only ever opens draft PRs.

**Rejected.** Machine-scoped identity (one gh account per machine forces
one deployment identity per machine and fights the operator's personal
sign-in). `GH_TOKEN` in the scheduled command line (secrets in
crontabs/plists; etium as credential handler). A trusted-list *and*
permission checks (two authorization systems). Cron-only wake-up
(forecloses launchd's event-driven future and demotes the laptop half of
the audience — the earlier tunnel vision, reversed on analysis).

---

## ADR-023 — comments are the only kickoff; freestyle is interpreted, never guessed

**Decision.** Assignment does nothing. A `/et <anything>` comment on an
open issue by anyone with Write — when no attempt is active — starts one,
and the comment's text rides into the run as the `directive` param. The
poll is one repo-wide comment stream (`issues/comments?since=<cursor>`,
cursor starting at "now" on first tick so history is inert), preceded by a
direct-fetch lifecycle sweep of every active run's issue and PR. On a
waiting run, an exact `/et <option>` decides the gate; any other text is
delivered as the `consider` decision with the full message as its note —
a gate option loops declare when they accept freestyle. The ai-engineer
declares it everywhere: an interpreter persona reads the message against
the gate's vocabulary and answers in `ai/REPLY.md` with `ACTION: <option>`
or `ACTION: unclear` plus one clarifying question, in which case the gate
re-opens showing the question. A kickoff directive short-circuits the
first route gate: triage is told the directive is the routing answer, and
the loop follows the intake's `## Route` line straight into the stage.
The status comment lists exact commands and adds "or just say what you
want: `/et <your words>`".

**Why.** Assignment-as-trigger breaks the moment the operator drives
etium from their own account — self-assignment is a normal act that must
not summon an agent, and assignees are load-bearing social metadata.
A comment is already the command channel, so kickoff becomes the same
grammar as everything else: one verb, `/et`, from first word to merge.
Freestyle-with-interpretation keeps the ledger's vocabulary closed (core
still validates every decision against declared options, fail-closed)
while letting the human speak naturally; "didn't understand, rephrase" is
the honest failure mode, and it costs one comment instead of one wrong
stage. The `since` stream is one API call per tick regardless of issue
count, and the cursor-starts-now rule makes old comments incapable of
waking anything.

**Rejected.** Assignment as a second trigger alongside comments (two
grammars, and the self-assignment trap stays). Letting the surface fuzzy-
match freestyle onto options itself (the surface would be guessing with
no context; the loop has the `ai/` documents and a model to read them).
An `interpret` gate option listed in the status comment (it is plumbing,
not a command a human should type). Free-text decisions written straight
into the ledger (the vocabulary is the contract; interpretation must end
in a declared word or a question).

---

## ADR-024 — clone-loop replaces only on request, and always leaves a rollback

**Decision.** `clone-loop` into an existing directory still refuses by
default. `--replace` is the consent: the existing copy moves aside to
`<dir>.old` (then `.old.2`, `.old.3`… — a rollback is never clobbered,
nothing is ever deleted) and the packaged version is cloned fresh.
Interactive `configure` asks the question itself when the chosen library
already exists — keep (default) or replace — and delegates to
`clone-loop --replace`, the same code path. Flags mode keeps the existing
copy untouched, as before: replacement never happens without an explicit
yes.

**Why.** Copy-and-own (ADR-013) made upgrades a hand-rolled
move-aside-and-diff — a documented workaround where the tool should act.
The user's consent is the overwrite; the backup is not a question worth
asking, so it is automatic. Suffixed rollbacks keep the guarantee
monotone: no sequence of replaces loses an edited copy.

**Rejected.** Silent overwrite on re-run (the user's copy is the product;
ADR-013 stands). Auto-merging package changes into an edited clone (a
diff the user runs beats a merge the tool guesses). Deleting the backup
after a successful clone (satisfaction is the user's call, not the
tool's). A confirmation for creating the backup itself (regret insurance
should not be declinable).

---

## ADR-025 — deployment-default params; harnesses resolve per step

**Decision.** `.etium/config.json` gains `params`: default loop params for
every run this deployment creates. The github surface and `etium run`
merge them *under* the run's own values — explicit flags, surface-computed
params, and task fields always win, and `writeConfig` preserves
hand-edited params across re-runs. The ai-engineer resolves harness and
model per persona: `harness.<step>` / `model.<step>` beat the loop-wide
`harness` / `model` (the same naming pattern as `cmd.<step>`), and the
loop's `?? "pi"` remains only as the last resort for bare, unconfigured
runs. `configure` asks one new question — the default harness, offering
what is actually installed — records the answer in `params.harness`, and
prints an ok/needs line for **every** harness the params reference
(`harness` and each `harness.<step>`), probed with the same pre-spawn
gate runs hit, so "this persona's harness isn't on this machine" is
caught at configure time with the remedy printed, not mid-run.

**Why.** The default harness lived only inside loop code, invisible to
configure — the machine knew pi was absent and still let a run reach the
step gate before saying so, and pointing a deployment at codex meant
editing the cloned loop (a customization that re-cloning then had to
re-apply). Params are already the loop's configuration surface; config
carrying defaults for them adds no new concept, generalizes to every knob
(`rounds`, `check`, `wall`), and supports one deployment running
different harnesses and models per persona — the actual intended use.

**Rejected.** A single blessed `harness` config field (collapses the
per-persona case). Loops declaring their needs in a manifest or exported
constant (a second source of truth that drifts from the code, and
configure would have to execute loop code to read it). The surface
hardcoding params (deliberately reverted earlier; config params are the
operator's recorded answer, not the surface's opinion).

---

## ADR-026 — no intake stage: the interpreter is the whole front door

**Decision.** The ai-engineer's triage stage and its `ai/INTAKE.md`
artifact are gone. The state machine is debug / design / plan / implement,
and its entire front door is one conversion: the operator's words → an
option the machine declares at this point. An exact option word is taken
literally (no model). Anything else goes to the interpreter persona, which
may study the repository to settle intent but writes only `ai/REPLY.md` —
`ACTION: <option>` or `ACTION: unclear` plus one question — and the
unclear case re-opens the gate showing the question. The kickoff directive
is just the first such message: `/et come up with a design` interprets to
`design` and the stage starts with no gate; `/et hmm the thing` parks at
the route gate with the clarifying question in the status comment.
`REPLY.md` is working state, never committed on its own; `route` no longer
offers `triage`.

**Why.** Intake blurred the stage boundaries it was supposed to guard: on
its first real outing it opened with "Design a two-layer contract" —
doing the designer's work in the analyst's document — and burned ~780k
tokens producing findings every stage persona re-derives anyway, since
each one studies the repository itself. Its one unique output was a single
routing word, which the interpreter produces for a fraction of the cost
without leaving an unexpected document in the PR. Removing it also removes
a whole failure class: the intake→auto-route handshake (a `## Route`
heading the template never instructed) broke on the first real model
output; `ACTION:` in REPLY.md is one pinned line, the same contract shape
review's `VERDICT:` already proves out.

**Rejected.** Keeping intake with a pinned `ROUTE:` line (fixes the
handshake, keeps the boundary blur and the token bill). Renaming
INTAKE.md → TRIAGE.md (labels the confusion, doesn't remove it). The
surface fuzzy-matching freestyle onto options itself (it lacks the
repository and the `ai/` context; mapping words to actions is model work,
scoped to one tiny persona).

---

## ADR-027 — the reviewer's verdict turns on blockers; approval carries notes

**Decision.** The ai-engineer's shared reviewer frame (`templates/review.md`)
splits findings into blockers (acted on as written, a later stage builds
the wrong thing, breaks something, or contradicts the task — these force
`VERDICT: revise`) and notes (real but non-blocking — they ride under
`VERDICT: approve`, never costing a round). Reviews carry a
`Resolved since last review:` accounting line, and a blocker raised for
the first time after round one must state what changed to expose it —
otherwise it is a note. Approval is framed as the expected outcome when
prior blockers are resolved and nothing new meets the bar. The old
"previous review is history, not input" rule is replaced: the previous
review is input for the accounting; the document is still judged fresh.
The loop's approval check (`^VERDICT: approve`) is unchanged — this is
template-only. Evidence for every rule: `ai-engineer/REVIEW_CONVERGENCE.md`.

**Why.** A live run produced eight distinct objections in four rounds
with a 100% fix rate and zero repeats — a reviewer that will never
approve, because withholding approval was its only way to speak and
nothing raised the bar on late findings. The field's measurements say
this is structural (LLM critics hallucinate errors on correct work at
79.6–97.1%; production reviewers found 79% of raw comments were nits),
and the working mitigations are exactly these: severity tiers where only
blockers gate (CodeRabbit, Qodo, Copilot, Google's "favor approving"),
delta-scoped re-review with resolved tracking, and approval-as-default
framing. Loops converge only when stopping is not the critic's call.

**Rejected.** Numeric self-scored severity with a threshold (Greptile
measured LLM self-judgment of its own comments as "nearly random").
Exhortations to be less picky (self-assessment is the broken
instrument). More rounds (improvement front-loads; forced continuation
measurably degrades). A stagnation auto-stop (ChatDev's two-unchanged
rule — with rounds=2 the stuck gate fires as fast and keeps the human
in the decision).

---

## ADR-028 — gates carry a reason; reasoned gates escalate as their own comment

**Decision.** `run.gate` accepts an optional `reason` string, recorded
on `gate.opened` (additive; consumers ignore unknown fields). The
ai-engineer's stuck gates pass one ("the design reviewer still objects
after 2 rounds — blockers in REVIEW.md") and reorder `show` so
REVIEW.md leads. The github surface headlines the reason in the status
comment and posts one **immutable** escalation comment per reasoned gate
occurrence (idempotent by `<!-- et:gate <run> <name>.<occ> -->` marker):
the reason, the valid commands, and an excerpt of the first shown file.
The mutable status comment remains the dashboard; escalation comments
are never edited. Routine gates (no reason) stay dashboard-only.

**Why.** The status comment is rewritten in place — deliberate anti-spam
— but that made the one moment needing a human invisible twice over: the
stuck story was overwritten when state moved on, and GitHub does not
notify on comment edits, only on new comments. A field-tested stuck gate
also excerpted the wrong file (the design's opening lines instead of the
reviewer's objections) because show-order carried no notion of what
mattered. Reason-presence is the loop's own definition of "worth a
human's attention," so the surface needs no gate-name pattern matching.

**Rejected.** Escalating every gate (route gates open constantly —
spam). An append-only log section inside the single status comment
(unbounded growth, still no notification). Surface-side heuristics for
which gates matter (the loop knows; the surface should not guess).

---

## ADR-029 — append-only narration; key points and links, never excerpts

**Decision.** The github surface's mutable status comment is gone
(supersedes the one-status-comment model and ADR-028's two-tier split).
Outbound projection is append-only narration: per tick, one comment
covering the run's notable ledger events since the last posted marker
(`<!-- et:seq <run> <seq> -->` — the thread itself is the projection
cursor; no new state files). Narrated events: attempt start, persona
step starts/completions (commits skipped; adjacent complete→start pairs
read as one "X complete → Y" transition), gate openings (reason
headline, valid commands, freestyle hint), decisions with author and
note, budget kills, completion with token usage. Comments are never
edited. Raw first-N-line excerpts are gone everywhere: a shown artifact
is presented as its **key points** — its `VERDICT:`/`ACTION:` first line
and its markdown headings, extracted structurally — plus a link to the
file on the run's branch, added only once the file is actually
committed. Summaries stay model-free (Invariant 1): prose belongs to the
loop (gate `reason`, the documents' own structure), never to the
surface.

**Why.** The rewritten dashboard erased history and never notified —
both bitten in the field — and its 8-line excerpt showed whatever
happened to open the file (a design's preamble) instead of what
mattered (the reviewer's blockers). Appended comments are events, which
is what the whole system already is: they persist, they notify, they
read in order, and the marker scheme makes them idempotent without any
surface-side state. Heading extraction is honest summarization the
surface can do without calling a model, and the templates already pin
the machine-readable lines (`VERDICT:`, `ACTION:`) that make it work;
the branch link hands the reader the full text one click away.

**Rejected.** Model-generated summaries in the surface (Invariant 1).
Keeping the mutable dashboard alongside narration (two places to read,
and its excerpt problem stays). One comment per ledger event (a tick
can carry several; a batched narration reads as one coherent
transition). Per-run cursor files for projection state (the posted
markers already are that state, and they survive anything the run dir
doesn't).

---

## ADR-030 — config is the deployment; commands mount what it declares

**Decision.** `etium tick` and `etium watch` take no `--surface` flag:
they mount the surfaces `.etium/config.json` declares, through one
plural-contract resolver (`configuredSurfaces` — today it yields the
github wiring or nothing; a future `surfaces` config field appends
entries without touching any command). The env the github surface reads
internally is injected there from config, explicit env always winning.
`etium run` without `--loop` defaults to the configured library's loop,
falling back to `ralph/loop.ts` only when unconfigured. The wake-up line
collapses to `cd <checkout> && etium tick` — no env, no flag — so
configure re-runs change behavior by writing config alone, never by
touching the scheduler; the frozen-ABI enumerator (ADR-020) additionally
matches the old `etium tick --surface github` signature forever, and
lines installed from now on are identified by the identity marker. The
comment cursor becomes id-based: `<lastCommentId>@<lastSeenISO>` —
comment ids are the authority (monotonic, clock-free; edits keep their
id and never redeliver), the timestamp only feeds GitHub's `since`
filter with a two-minute overlap so listing lag cannot lose a comment,
and a `created_at` floor keeps edited history inert. Old ISO cursors
migrate in place on their first tick. Path-loaded custom surfaces lose
their only mount — a recorded deferral until a `surfaces` config field
exists, not a hidden regression.

**Why.** A live deployment ran `etium tick` after commenting `/et` and
nothing happened: the bare command reconciled runs but polled nothing,
because the surface mount lived in a flag plus two env vars that only
the LaunchAgent's baked line carried. Two commands under one name is the
failure; the audit found the same disease in `run`'s hardcoded ralph
default ignoring the configured library. ADR-019 drew the boundary
"config is configure's memory, never the runtime's input" — ADR-025
already breached it for params; this completes the reversal: the
deployment's recorded answers are the deployment, flags exist to be
explicit per-invocation, and a flag that overrides config for one run is
the contract while a default that ignores config is a bug. The
timestamp cursor was a clock-dependence bug in waiting: a comment
becoming API-visible after the cursor passed its created_at was lost
forever.

**Rejected.** Keeping `--surface` alongside the config mount (two paths
again). Baking env into the wake-up line (rewiring then requires
scheduler surgery; secrets-adjacent strings in crontabs). A
`surfaces` config field today (nothing real to put in it). Cursoring on
ids alone without the created_at floor (an edited pre-deployment
comment could kick off work — history must stay inert).

---

## ADR-031 — design is never optional; a design has a declared style

**Decision.** The route to `plan` is earned by a converged design, the
same fail-closed construction that gates `implement` behind a plan and
`wrap-up` behind implementation: the base route vocabulary is
`debug · design`, and each later stage appears only when its
prerequisite converged. To keep the mandatory stage cheap, `design.md`
declares three design styles — mini (a bug fix or small feature: state
the simple solution, no invented abstractions), component (interfaces
and data flow precise enough that two planners write the same plan),
full (new components, state machines, protocols: options at strength,
invariants, failure modes, complete interfaces) — the designer opens by
naming its style and why, choosing the lightest that carries the task;
overbuilding is a defect at every style. The design reviewer reviews at
the declared style's altitude: demanding more than the style requires
is an objection against the review; a style too light for its task
earns exactly one blocker (the style, with why). The plan reviewer
holds the boundary from the other side: the plan may add detail, never
components — machinery absent from the design is an objection.

**Why.** A live run turned "modify the prompt so replies are never
emoji-only" into a six-round plan cycle: the planner invented a
streaming gate state machine inside the plan stage, and the plan
reviewer — whose whole vocabulary is "is this buildable as written" —
was forced to design-review the invention one underspecified corner at
a time. Each objection was individually legitimate; the waste was
structural: architecture appeared in the stage with no altitude to
judge it. Making design mandatory moves invention to the stage whose
reviewer can say "why does this machinery exist"; the styles ladder
keeps the mandate from taxing small fixes; the altitude rule keeps the
reviewer from nitpicking a mini into a full design, which would
recreate the cascade one stage earlier.

**Rejected.** A simplicity objection class in plan-review alone (treats
the symptom; the invention still happens in a stage that cannot weigh
options). Letting the planner self-escalate to design when it notices
itself inventing (asks the persona least able to see its own
overbuilding to police it). Design optional for "obvious" fixes (the
xcnc run's fix looked obvious; the mini style prices the stage at a
paragraph instead of skipping the judgment).

---

## ADR-032 — narration links pin the round's exact commit

**Decision.** The loop's `commit` step records the resulting sha as a
`"sha"` effect (guarded: empty outside a git checkout), putting the
version identity of every round's documents in the ledger. The github
narration pairs each artifact-bearing step with the first sha recorded
after it and renders the step name as a link to that blob —
`blob/<sha>/<file>` — so "plan" in the round-3 comment is round 3's
PLAN.md forever, distinct from round 4's; gate key-point links pin the
same way. The primary document is `artifacts[0]` by convention: loops
declare it first (the stage's own file, then the `ai/*.md` glob).

**Why.** Branch-ref links answer "what is the plan now," not "what plan
was this comment about" — the narration is history, and history's links
must not move. The sha is recorded by the loop rather than
reconstructed from `git log` because ordinal matching drifts the moment
a round produces no diff (the guarded commit no-ops), while a
ledger-recorded effect is replay-exact and costs one line.

**Rejected.** Branch-pinned links (mutable history). Reconstructing
step→commit from commit messages at projection time (ordinal drift, and
projection often runs rounds later). Linking every artifact a step
collected (the glob collects the whole `ai/` folder; one primary link
per step is the readable unit).

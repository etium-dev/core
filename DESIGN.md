# Etium — Design

Status: draft v0.1 (pre-implementation). This document is the technical contract for etium's core. The companion `PRODUCT.md` is the positioning document and webpage source. When the two disagree, this document wins on mechanism and `PRODUCT.md` wins on scope.

---

## 1. Positioning (summary)

Etium is a supervisor for headless coding agents. It owns the outer loop — tasks, runs, budgets, gates, and the event ledger — and delegates the entire inner loop (context, tools, model calls) to existing harnesses via thin adapters. Pi's equation is agent = model + minimal harness; etium's is team = harnesses + minimal loop. Etium is the loop.

The full positioning argument, non-goals-as-promises, and comparisons live in `PRODUCT.md`. This document specifies how the core works.

---

## 2. Invariants

These are the behavioral contract. Changes to core must preserve them or amend this list in the same change.

1. **Etium never calls a model.** If a feature needs an LLM, it belongs in a harness or a loop step, not in core.
2. **The ledger is the sole source of truth.** Every other view — `state.json`, `etium status`, a GitHub comment — is a derived, rebuildable projection.
3. **All state transitions are events.** A human decision is an event like any other.
4. **Single writer per ledger.** Exactly one process appends to a run's ledger at a time, enforced by a lockfile. Everyone else drops requests into the decisions mailbox.
5. **Every step runs under an explicit budget** and can be killed without corrupting the run.
6. **Steps are fresh-context by default and at-least-once.** Completed steps are exactly-once via replay memoization. Continuity lives in files, not conversations.
7. **Gates fail closed.** Decisions are explicit, attributed, and consumed once.
8. **Least environment per step.** Publication credentials never enter agent-controlled processes. Model credentials enter agent steps only by adapter declaration, and every passed-through value is redacted from raw (`MODEL_AUTH.md`, ADR-007).
9. **Crash-only.** Any etium process may die at any instant; `etium tick` restores correctness without human intervention.
10. **Anything not covered above is an adapter or a loop, not core.**

---

## 3. Primitives

Six nouns. Core contains nothing else.

| Primitive | Definition | Materialization |
|---|---|---|
| **Task** | A goal plus acceptance criteria. Source-agnostic. | `task.md` (optionally with YAML frontmatter for params) |
| **Run** | One attempt at a task. | A directory under `.etium/runs/<run-id>/` |
| **Loop** | A program sequencing steps and gates. | An ordinary TypeScript file exporting an async function |
| **Step** | One headless harness invocation: prompt, workspace, env profile, budget. | A subprocess + a step directory (prompt, raw log, artifacts) |
| **Gate** | A named pause requiring an external decision. | `gate.opened` / `gate.decided` events |
| **Ledger** | Append-only record of everything that happened. | `events.jsonl` per run |

Run IDs are strings: `<date>-<slug>-<4 random chars>`, e.g. `2026-07-30-fix-flaky-auth-k3f9`.

---

## 4. On-disk layout

Well-known paths are the most language-neutral API there is. Everything below is part of the stable contract except where marked internal.

```
.etium/
  config.ts                 # optional; core-only (see §14, open item)
  runs/
    <run-id>/
      task.md               # immutable for the life of the run
      loop.json             # { "loop": "<path-or-package>", "params": {...} } — resolved at creation
      events.jsonl          # THE ledger (§5)
      state.json            # derived cache; rebuildable via `etium rebuild` (internal format)
      lock                  # supervisor lockfile: { pid, host, started } (internal)
      decisions/            # mailbox: pending decision files awaiting ingestion (§8)
      steps/
        <seq>-<name>.<occ>/ # e.g. 003-implement.0/
          prompt.md          # exact prompt sent, after template + note injection
          raw.jsonl          # raw harness stream while running
          raw.jsonl.zst      # compressed on completion; sha256 recorded in ledger
          artifacts/         # declared step outputs (§7)
      workspace -> ../../worktrees/<run-id>    # symlink; plain-dir workspaces point elsewhere
  worktrees/
    <run-id>/               # git worktree per run (opt-in: `--worktree`; branch etium/<run-id>, ADR-010)
  surfaces/
    <id>.cursor             # opaque surface cursors (§10.3; internal)
```

Retention: ledgers are kept forever. `etium gc` prunes `raw.jsonl.zst`, `stderr.log`, and worktrees by age/count policy. Deleting raw later is easy; recovering unrecorded raw is impossible, so we record first and prune second.

---

## 5. The ledger

### 5.1 Format

Newline-delimited JSON (JSONL), append-only, single writer. Crash recovery rule: if the final line is torn (no trailing newline or fails to parse), truncate it and continue. Corruption is localized to a line by construction.

### 5.2 Envelope

```json
{ "v": 1, "ts": "2026-07-30T18:41:02.117Z", "run": "2026-07-30-fix-flaky-auth-k3f9",
  "seq": 42, "type": "step.completed", "data": { } }
```

`seq` is a per-run monotonically increasing integer assigned by the single writer. `v` is the schema version for the whole envelope+types set.

### 5.3 JSON conventions (normative)

- Identifiers are strings. No integer field may plausibly exceed 2^53 (token counts, costs-in-microdollars, seq are all fine).
- Timestamps are RFC 3339 UTC strings.
- No binary and no large payloads in the ledger. Payloads live in files; the ledger holds pointers (`RawRef`, artifact paths) and sha256 hashes.
- Consumers ignore unknown fields; producers never repurpose a field's meaning within a `v`.
- The contract is enforced by a published JSON Schema plus golden fixtures in the repo, not by the format itself.

`RawRef` is `{ "file": "steps/003-implement.0/raw.jsonl", "line": 1234 }` — line index into the uncompressed raw stream.

### 5.4 Event types (v1)

| Type | Emitted by | Data (essentials) |
|---|---|---|
| `run.created` | CLI | task hash, loop ref, params, worktree (repo, branch, base, baseSha)?, etium version |
| `supervisor.started` | supervisor | pid, host — emitted on every attach (start and resume) |
| `step.started` | supervisor | name, occ, harness, model?, prompt sha256, env profile, auth env names?, budget, config digest |
| `step.activity` | supervisor | step ref, kind: `message` \| `tool` \| `usage`, summary (short string), usage delta?, raw: RawRef |
| `step.completed` | supervisor | step ref, status: `ok` \| `error` \| `killed` \| `budget`, exit code?, usage totals, raw file + sha256, artifacts[], passed? |
| `gate.opened` | supervisor | name, occ, options (declared answer set; `["approve","reject"]` when undeclared), show: artifact refs |
| `gate.decided` | lock holder | name, occ, decision: one element of the recorded options, note?, by, via: `cli` \| `preapproval` \| `github` \| `mcp` |
| `effect.recorded` | supervisor | name, occ, value (small JSON) |
| `budget.warning` | supervisor | step ref?, kind: `stall` \| `approaching`, detail |
| `budget.exceeded` | supervisor | step ref, which budget, action: `killed` |
| `run.parked` | supervisor | open gates[] — supervisor exits after emitting |
| `run.interrupted` | supervisor (on attach) | reason: `stale-lock` \| `no-lock`, prior pid/host, lock age |
| `run.completed` | supervisor or CLI | status: `done` \| `abandoned` \| `superseded` \| `error`, summary |

Reserved for M1: `step.invalidated` (human `etium redo` marks a completed step for re-execution on next replay).

Authority split, stated once: the **ledger is authoritative for control flow** (steps, gates, decisions, budgets, outcomes); **raw is authoritative for step content** (full messages, tool payloads, reasoning). `step.activity` carries summaries and pointers, never full payloads, so the ledger stays small and greppable.

---

## 6. Execution model

### 6.1 Processes

There is no daemon. Three process roles, all short-lived or step-lived:

- **CLI** (`etium ...`): creates runs, reads projections, drops decisions, spawns supervisors detached.
- **Supervisor** (one per active run): holds the lock, executes the loop function under replay, spawns step subprocesses, enforces budgets, appends events. Exits when the run completes, errors, or parks.
- **`etium tick`**: idempotent janitor. For each run: skip live supervisors and completed runs; if the run is resumable (interrupted; running with a dead or stale lock; created but never supervised; or parked with a pending decision in the mailbox) → spawn a detached supervisor. The attaching supervisor — never tick — clears the stale lock and appends `run.interrupted` (with the dead holder's pid/host/lock age, or `no-lock` if a prior supervisor died between releasing the lock and recording an outcome), preserving Invariant 4: only the lock holder writes. Guarded by a global tick lock so overlapping cron invocations no-op; the lock records its holder's pid+host, and a holder that no longer answers on this host (killed mid-tick — e.g. launchd bootout during a configure re-run) is stolen by the next tick, loudly (`recover` action), with lock age as the fallback staleness test for foreign or unreadable locks. `tick` also drives pull-based surface adapters (§10.3) when invoked with `--surface <path>`: surfaces are polled first (so a decision polled this tick resumes its run this tick), runs are reconciled second, projections run last.

`etium watch` is sugar: tick on an interval, foreground. It holds no state and gets no socket. Cron calling `tick` is the supported "automation" mechanism; scheduling semantics belong to cron.

### 6.2 Replay-memoized loop execution

On every supervisor attach, the loop function executes from the top. Each `run.step()`, `run.gate()`, and `run.effect()` call is memoized against the ledger:

- **Key** = (kind, name, occurrence). Occurrence = count of prior calls with the same kind+name in this execution, assigned synchronously at call time — deterministic under `Promise.all` and under ralph-style iteration.
- **Hit** (a `*.completed`/`gate.decided`/`effect.recorded` exists for the key): return the recorded result instantly. Completed work is exactly-once.
- **Miss**: execute for real (spawn the step, open the gate, run the effect fn) and record.
- **Divergence**: a ledger entry exists for the key but its config digest (harness, model, prompt hash, budget, env profile) differs from the replayed call → hard error naming the exact mismatch. Never silently corrupt. Escape hatches: rename the step, or `etium redo` (M1).
- **Orphans**: completed ledger entries never reached during replay produce a warning, not an error (loops evolve).

Determinism rules for loop authors (enforced by review and by divergence detection, documented loudly): route every nondeterministic value through `run.effect("name", fn)`; no clocks, no sleeps, no network in loop code — cadence belongs to cron, waiting belongs to gates, work belongs to steps. Loop functions are milliseconds of glue; everything expensive is memoized.

### 6.3 Steps

A step is at-least-once. If a supervisor dies mid-step, resume re-executes that step from scratch with fresh context; the previous attempt's partial `raw.jsonl` is preserved automatically: each attempt appends its own `step.started` and therefore gets its own `steps/<seq>-<name>.<occ>/` directory, so re-execution never overwrites an earlier attempt's raw. Consequences, documented as loop-authoring guidance: steps should leave the workspace in a state they can re-enter (from M1, with worktrees, the reference loops have each step commit its work to the run's branch, so an interrupted step's partial work is visible as an uncommitted diff and recoverable or resettable).

Auth preflight at the step boundary: on a memo miss, before `step.started` is appended, the supervisor runs the adapter's declared auth check (§10.1) — non-interactive, short timeout, cached per harness for the life of the attach. A definitive failure (non-zero exit, missing binary) errors the run with the adapter's remedy verbatim in `run.completed.summary` — e.g. ``harness codex not authenticated — run: codex login``. Because nothing was appended for the step's key, no occurrence is consumed and nothing is memoized: after the operator authenticates, `etium resume` replays to the identical point and the step executes for the first time — a run completed `error` stays resumable by explicit attach, while `tick` skips all completed runs, so errors are never retried unattended. An indeterminate check (timeout) proceeds with a stderr warning — unattended resumes must never block on a flaky check; if auth is truly broken the step itself fails legibly. This is the authoritative auth gate; the `etium run` preflight (§9) is a best-effort fast path in front of it.

Step outcome: `run.step()` returns `{ status, exit, passed, artifact(name), usage }`. It does not throw on step failure — `status: error | killed | budget` is a value the loop branches on. It throws only on etium-internal errors (divergence, ledger corruption).

`passed` semantics: if the step declares a `grade` (§10.4), passed = grader exit 0; else for `exec` steps, passed = exit 0; else undefined.

Artifacts: a step option `artifacts: ["PLAN.md", "reports/*.md"]` — globs relative to the workspace, copied into the step directory on completion and listed in `step.completed`. `result.artifact("PLAN.md")` resolves to the copied path.

### 6.4 Budgets

Per-step: `wall` (always enforceable), `tokens`, `cost` (enforceable only when the adapter reports usage; otherwise the step is marked **unmetered** in `step.started`), `stallWarn` (default 15m — emits `budget.warning`, never kills; long tool or model work is legitimate). Per-run: a step-count guard (default 100, M0) plus `wall` and `cost` (M1, with usage/cost normalization). Iteration limits are loop logic, not core.

Enforcement: the supervisor kills the subprocess tree on breach, emits `budget.exceeded`, then `step.completed` with `status: budget`. The loop sees it as a value and typically opens a gate.

Defaults carried from the predecessor system, encoded in the reference loops rather than core: 2h planning steps, 10h implementation steps, 20-iteration guard, escalate when the same reviewer objection survives two revisions.

### 6.5 Parking and gates at runtime

When every pending await in the loop is a gate with no decision, the supervisor emits `run.parked` and **exits**. A gate can stay open for days; a process should not. Re-entry is cheap because replay-memoization makes "exit and re-execute to the same point" the normal path, not a special one.

---

## 7. Loop API

Loops are plain code. No DSL, no YAML, no build step (Node ≥ 22 type stripping runs `.ts` loop files directly).

```ts
// plan-implement — an M1 reference loop library (sketch)
import type { Run } from "@etium/core";
import { t } from "@etium/core";  // template loader, relative to this file; {{param}} interpolation

export default async function planImplement(run: Run) {
  const plan = await run.step("plan", {
    harness: "codex",
    prompt: t("plan.md"),
    artifacts: ["PLAN.md"],
    budget: { wall: "2h" },
  });

  const d = await run.gate("plan-approved", { show: [plan.artifact("PLAN.md")] });
  if (d.decision === "reject") return run.abandon("plan rejected");

  await run.step("implement", { harness: "codex", prompt: t("implement.md"),
    budget: { wall: "10h" } });

  const check = await run.step("verify", {
    harness: "claude", model: "opus",
    prompt: t("verify.md"), grade: "npm test",
  });
  if (!check.passed) await run.gate("needs-human", { show: [check.artifact("report.md")] });

  await run.gate("merge-approved");
}
```

```ts
// ralph/loop.ts — the reference loop (cloned into your repo by `etium clone-loop ralph`)
import type { Run } from "@etium/core";
import { t } from "@etium/core";

export default async function ralph(run: Run) {
  const max = Number(run.params.iterations ?? 30);
  for (let i = 0; i < max; i++) {
    await run.step("iterate", { harness: run.params.harness ?? "codex", prompt: t("PROMPT.md") });
    const check = await run.step("check", { harness: "exec", command: run.params.check });
    if (check.passed) return;
  }
  await run.gate("iteration-guard");
}
```

API surface (complete): `run.step(name, opts)`, `run.gate(name, opts?)`, `run.effect(name, fn)`, `run.abandon(reason)`, `run.task`, `run.params`, `run.id`, `run.workspace`, and `t(file)` (also available as `run.t(file)`). That is the whole vocabulary.

A gate is a question with a declared, finite answer set (ADR-008): `run.gate(name, { options: ["debug", "architecture", "plan"] })` returns `{ decision, note?, by }` where `decision` is the chosen element — deterministic loop code branches on it with a `switch`. Gates that declare nothing get the default set `["approve", "reject"]`; the binary gate is the degenerate case, not the definition. Free-form human input still travels in the note, whose consumer is the next prompt. Reference loops: `ralph` (M0), `plan-implement` (M1, above), `triage` (M2). Everything else is user-authored.

Gate notes: when a decision carries `--note`, the note is recorded in `gate.decided`, returned from `run.gate()`, and additionally auto-appended to the next step's prompt (visible in that step's `prompt.md`). Feedback is snapshotted at step start; nothing arriving mid-step is injected.

---

## 8. Gates and decisions

- `gate.opened` records the declared answer set (`options`) and lists artifact refs to show the human. `etium gates` renders the inbox across all runs, including each gate's options.
- Decisions travel through the **mailbox**: `etium approve <run> <gate> [--note ...]` (sugar for the default binary set) or `etium decide <run> <gate> <option> [--note ...]` writes `decisions/<gate>.<occ>.json` `{ decision, note, by, via, ts }`. The lock holder ingests mailbox files, appends `gate.decided`, and deletes the file — consumed once, even with a live supervisor running parallel steps. If no supervisor is alive, the CLI verifies the gate is open, writes the decision file, and spawns a detached supervisor, returning immediately; the supervisor ingests the mailbox at attach (`etium tail` to watch). The CLI never takes the run lock itself.
- Decisions fail closed twice over: the gate must be open, and the decision must be an element of the option set **as recorded in `gate.opened`** — the ledger, not current loop code, is the validation authority (if the two drift after a loop edit, the supervisor warns and the ledger governs). Invalid decisions are dropped with a message naming the declared options. The sanctioned pre-approval path is explicit at run creation: `etium run --approve merge-approved ...` records intent; when that gate opens it is immediately decided with `via: "preapproval"` — and errors loudly if the gate's declared options do not include `"approve"`.
- Attribution: `by` is the OS user for CLI, the platform identity for surfaces (M2). Surfaces must enforce their own authorization (the GitHub surface delegates to the repository's own permission model: anyone with Write may command).

---

## 9. Security model

- **Env profiles**: every step names its profile; default is `agent`. M0 ships two built-ins: `agent` (fixed allowlist — PATH, HOME, locale, and similar; publication-credential-free) and `host` (full inherited environment, for publication steps), plus per-step `env.add` for explicit additions. Named custom profiles defined in config (e.g. a `publish` profile holding exactly `GH_TOKEN`) arrive with config-as-code (§14, open item 1). Publication (push, PR creation) never happens in `agent` steps — two sanctioned patterns: a standalone loop publishes via `exec` steps under `host`/`publish`; a loop designed for a surface publishes nothing, and the surface projects branch → PR → status under its own credentials (ADR-011). This is Invariant 8 made concrete; it preserves the predecessor system's hard-won boundary.
- **Model auth — declared passthrough** (`MODEL_AUTH.md`, ADR-007): model auth is harness-owned; etium never stores, prompts for, or refreshes a credential. An adapter may declare `auth.env` — the env var names its harness consumes for model credentials. Under the `agent` profile the runner copies each declared name present in the host environment into the step env, inherited at spawn time and stored nowhere; `HOME` stays on the allowlist so store/keychain-based harness auth keeps working. Every passed-through value joins the redaction secret list unconditionally — by declaration, not by the name heuristic. `step.started` records the *names* actually passed through (`authEnv`), never values; the field is informational and excluded from the config digest — host-env presence is runtime input, like operator notes (ADR-002), and must never cause DIVERGENCE. Precedence: explicit `env.add` beats declared passthrough beats profile allowlist. Preflight is two-tier: `etium run` checks the harnesses it can resolve from `--harness`/params *before* `run.created` — on definitive failure it creates nothing, exits non-zero, and prints the adapter's remedy verbatim; the authoritative check runs supervisor-side before each step's first spawn (§6.3), because harness choice can be runtime data. `etium configure` surfaces the same checks during setup — each unmet dependency printed with the exact command that fixes it — then asks the setup questions (or takes them as flags) and applies the answers; the preflights remain the gates.
- **Redaction**: the step runner scans raw and stderr lines for exact secret values and writes `[redacted]` before anything touches disk. M0 baseline: secrets are the values of inherited variables whose names match a credential pattern (TOKEN, SECRET, KEY, PASSWORD, …), all adapter-declared passthrough values, and any secret-named `env.add` values; config-marked secrets refine this with config-as-code. Grader output is redacted with the same secret list before `grade.txt` is written — the grader inherits the step env and must not become a plaintext path into the run directory. Documented limitations: encoded or split secrets are not caught; raw and artifacts contain repository content by nature, and a credentialed step can echo secrets into workspace files that `artifacts:` globs then copy verbatim; `prompt.md` is written pre-redaction, so secrets must not be smuggled through params or gate notes.
- **Isolation is delegated**: etium sets cwd and env and can invoke a harness through a user-supplied wrapper command (docker, container-use). Sandbox policy is the user's, per the non-goals.

---

## 10. Adapters

### 10.1 Harness adapter interface

Core owns spawning, raw capture, redaction, budgets, kill, and auth preflight. An adapter is two pure functions — a command builder and a line parser — plus an inert auth declaration, which is what keeps each one under ~300 LOC:

```ts
interface HarnessAdapter {
  id: string;
  auth?: {                        // model auth is harness-owned (MODEL_AUTH.md); this is inert data core acts on
    env?: string[];               // var names passed through into `agent` steps when present in the host env
    check?: { cmd: string; args: string[] }; // cheap, non-interactive, no browser; exit 0 = authenticated
    remedy?: string;              // the harness's own fix, printed verbatim — e.g. "codex login"
  };
  build(req: StepRequest): {
    cmd: string; args: string[];
    stdin?: string;               // prompt via stdin, arg, or file — adapter's choice
    env?: Record<string, string>; // additions only; profile is applied by core
  };
  parse?(line: string): HarnessEvent[] | null;  // optional (exec has none); null = unrecognized line (kept in raw only)
}

type HarnessEvent =
  | { kind: "message"; role: "assistant" | "system"; summary: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "usage"; usage: { tokensIn?: number; tokensOut?: number; costUsd?: number } }
  | { kind: "lifecycle"; state: "started" | "exiting" };
```

The runner tees raw bytes to `raw.jsonl`, feeds lines to `parse`, attaches `RawRef`s, and emits `step.activity`. Adapters never touch disk and never see credentials beyond their own `env` additions.

### 10.2 Built-in adapters

- **`exec`**: any command as a black-box step. No `parse`; stdout/stderr are the raw stream; only lifecycle events; unmetered. This is the interface floor and the publication-step vehicle.
- **`replay`**: plays a recorded raw stream through a named adapter's parser, with optional timing. Deterministic, token-free end-to-end runs; what the test suite and demos run on.
- **`codex`** (M0): built on Codex's headless JSON event stream (`codex exec --json` as the baseline; exact flags pinned during fixture capture).
- **`pi`** (pulled forward from M1 for the quick start): `pi -p --mode json` (session stream v3). Parser fully validated against captured fixtures (`fixtures/pi/`) — message, usage, error, lifecycle, and tool shapes, the last captured by an etium-supervised run itself. Pi exits 0 even on a failed turn — the parser surfaces the in-stream `errorMessage` as a message event so failures are visible in `etium tail`.
- **`claude`** (M1): Claude Code's stream-json. Raw fixtures from pi and claude are captured during M0 to validate the normalized schema against three formats before it hardens.
- **`openhands`** (M2): drives the OpenHands CLI's headless mode as a subprocess — never the agent-server, whose contract expects LLM credentials in-band, which is exactly the brokering `MODEL_AUTH.md` rules out.

Auth declarations per adapter (ADR-007). Status commands and exit-code
semantics are pinned at fixture-capture time, like parser shapes (ADR-005);
entries marked *provisional* await that capture. A missing `check` simply
means creation-time preflight can only verify the binary exists — the step
still fails legibly at spawn if auth is absent.

| adapter | `auth.env` | `auth.check` | `auth.remedy` |
|---|---|---|---|
| `exec`, `replay` | — (none; the test substrate stays credential-free) | — | — |
| `codex` | `OPENAI_API_KEY` | `codex login status` (*provisional*: exit semantics unpinned) | `codex login` |
| `claude` | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | `claude auth status` (verified: non-interactive JSON, exit 0 when logged in; *provisional*: logged-out exit code unpinned) | `claude auth login` (or `claude setup-token` for a long-lived token) |
| `pi` | the providers pi documents: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, … (full list pinned with the adapter) | — (pi ships no status subcommand; OAuth store is `~/.pi/agent/auth.json`) | `pi` then `/login` (interactive) |
| `openhands` | `LLM_API_KEY` only — declared values are redacted, so non-secret config (`LLM_MODEL`, `LLM_BASE_URL`) does not belong in `auth.env`; the adapter's build() maps model/base-url from step options and adds `--override-with-envs` | — (*provisional*: no known status command; settings live in `~/.openhands/agent_settings.json`) | `openhands` then `/settings` (interactive) |

### 10.3 Surface adapter interface

Pull-based, driven by `etium tick --surface <name-or-path>` (repeatable).
Built-in surfaces resolve by name (`github`); anything with a `/` or `.`
loads as a user-supplied module, like a loop (ADR-009):

```ts
interface Surface {
  id: string;                       // becomes `via` on decisions; namespaces the cursor
  poll(ctx: { cursor: string | null; runs: RunView[] }):
    { tasks: SurfaceTask[]; decisions: SurfaceDecision[]; cursor: string | null };
  project?(run: RunView): void | Promise<void>;  // e.g. upsert one status comment
}
```

Semantics, all fail-closed and at-least-once:

- **Tasks** carry a required idempotency `key` — the id of the external event
  that triggered them (a new attempt is a new event, hence a new key). Core
  creates at most one run per `(surface id, key)`, recorded as the reserved
  run param `surface.task` (`surface` is also reserved); redelivery skips.
- **Decisions** name an exact run id and gate; core validates the gate is
  open and the decision is in the declared option set (§8) before writing the
  mailbox file with `via: <surface id>` — invalid ones are dropped and
  reported, never guessed. Surfaces should pre-validate against
  `runs[].openGates[].options` to give their own users a good error reply;
  core's check is the defensive layer.
- **Abandons** carry observed lifecycle facts that terminate runs — issue
  closed, PR closed unmerged, a superseding command. Core kills any live
  supervisor and marks the run `abandoned` (or `superseded`); completed runs
  are skipped. This is the one write channel besides decisions: facts end
  runs, decisions answer gates, nothing else crosses the boundary.
- **The cursor is opaque to core** — persisted under `.etium/surfaces/` and
  handed back on the next poll. Encode whatever the surface needs (timeline
  position, per-run projected seq). It advances only after the poll's actions
  land; a crash replays, and the key check plus fail-closed decisions absorb
  the redelivery.
- **Projections are idempotent and never read back** (Invariant 2). `project`
  runs for every run each tick, after reconciliation; a throwing surface is
  reported and skipped — it must never block reconciliation. `RunView` is the
  fold, read-only: id, dir, status, params, workspace, open gates (with
  options), usage, seq, completion. Anything more, the surface reads from the
  run directory — files are the API.

**The built-in `github` surface** (`etium tick --surface github`) is
loop-agnostic infrastructure. Inbound, it maps: a `/et …` comment on an
open issue with no active attempt (by anyone with Write) → a task running
the configured loop (`ETIUM_GH_LOOP`, required) on worktree branch
`etium/issue-N-attempt-K`, with the comment's text passed as the
`directive` param; **command comments** (`/et <option> [note]`, or
`@<agent> <option>`) by authors with Write → gate decisions, matched
against whichever open gate declares the option and validated against the
ledger's set — a comment matching no option is delivered as the `consider`
decision (full text as the note) when the gate declares it, for the loop
to interpret — never labels,
which are a mutable bitfield with no payload, no atomic consume, and no
attribution; `/et stop`, issue close, and PR close-unmerged → abandons; PR
merge → the `wrap-up` option when a gate declares it (the convention for "a
mergeable end"). Outbound, projection pushes the run's branch, opens one
draft PR once the branch has commits past its recorded `baseSha`, rewrites
one bot-owned status comment listing the currently-valid commands, and
maintains a write-only decoration label (`et:working` / `et:waiting` /
`et:blocked`) for issue-list filtering. Configuration is environment
variables with no secret values — `ETIUM_GH_REPO`, `ETIUM_GH_LOOP`,
`ETIUM_GH_WORKDIR`, `ETIUM_GH_BASE`. The surface acts as the deployment's
own repo-scoped gh sign-in (`.etium/gh` under the workdir, ADR-022), and
authorization delegates to the repository's permission model: anyone with
Write may command; everyone else is refused surface-side (§8 attribution).

### 10.4 Grader hook

`grade: string` (a shell command) on a step: after the harness exits, the runner executes the command in the workspace; exit 0 ⇒ `passed`, stdout captured as an artifact. A grader that needs a model is just another step with a different harness/model — the maker/checker split is loop composition, not a core feature.

---

## 11. Non-goals

Core will never contain: model API clients or context management; an MCP router (etium's boundary is subprocess + JSONL; an `etium-mcp` extension exposing status/approve/dispatch as tools is welcome later); a workflow DSL; a server, web UI, or authoritative database (a derived SQLite index for cross-run `status` at scale is acceptable later — a projection, never a source of truth); sandboxing; an eval framework (stable traces + exporter scripts instead); a scheduler daemon (cron + `tick`); a memory system (files in the workspace); a fleet control plane — no scheduler, queue, or coordinator in core; scale is composition (many repos and machines, each running the same daemonless loop, aggregated by projections), and the strict-consistency domain stays **one machine per active run**; GitHub as authoritative state — the built-in surface writes projections and consumes events, and nothing on GitHub is ever read back as truth; credential storage or brokering — no credential store, no `etium login`, no OAuth or token refresh, no secret-valued config field; adapter-declared passthrough and redaction (§9, `MODEL_AUTH.md`) are the entire model-auth surface.

---

## 12. Repo layout, size budgets, testing

```
etium/                    # a single npm package: `etium` (see DECISIONS ADR-006)
  src/                    # core ≤ ~3,000 LOC: ledger, fold, engine, runner, lock, mailbox, supervisor, tick
    adapters.ts           # exec, replay, codex, pi, claude, openhands — each ≤ ~300 LOC
    cli.ts
  ralph/                  # the reference loop library (M0) — copy-and-own via `etium clone-loop`, like ai-engineer/; plan-implement, triage follow (M1+); each loop ≤ ~150 LOC
  fixtures/               # captured raw streams per harness (golden transcripts)
  schema/                 # JSON Schema for envelope + events, versioned + golden example ledger
```

*Amended (ADR-006):* the original draft here sketched an npm-workspaces monorepo
(`packages/core`, `packages/cli`, …). Deferred until a second
independently-versioned artifact exists; the budgets below are the contract and
are unchanged, enforced per-area by `scripts/loc-budget.mjs`.

LOC budgets are enforced in CI and published in the README — both a feature and a constraint; the credibility test is "read core in an afternoon."

Testing: adapter parser tests against golden fixtures; property tests on the fold (random valid event interleavings preserve invariants); end-to-end on the `replay` harness; crash-injection (SIGKILL a real detached supervisor mid-step; assert `tick` recovers, completed steps never re-execute, interrupted steps re-execute at most from scratch); torn-last-line recovery tests. Model auth (ADR-007): `resolveEnv` passes declared-and-present vars through under `agent`, omits absent ones, leaves `host` and `env.add` precedence unchanged, and registers every passed-through value as a redaction secret unconditionally; passthrough values are redacted in raw, stderr, and `grade.txt`; a failing pre-spawn check appends no `step.started`, ends the run `error` with the remedy in the summary, and a subsequent resume executes the step under the same occurrence; changing host-env credential presence between attaches never diverges; `doctor` against a fake adapter; `exec`/`replay` declare nothing, keeping the test substrate credential-free.

CLI (M0 set): `run`, `status`, `tail`, `gates`, `approve`, `reject`, `decide`, `resume`, `abandon`, `tick`, `rebuild`, `clone-loop`, `watch`, `init`. M1 adds: `redo`, `gc`.

---

## 13. Milestones

**M0 — kernel.** Ledger + fold + engine (replay memoization, divergence, parking), runner (raw capture, redaction, wall/stall budgets, kill), lockfile + mailbox + `tick`, adapters `exec` + `replay` + `codex`, the `ralph` loop, the M0 CLI set, plain-directory workspaces. Fixture capture from Claude Code and Pi to validate schema neutrality. Exit criteria: etium is being developed by a Codex ralph loop running under etium, and `kill -9` at any point is recovered by `tick`.

**M1 — daily driver.** Git worktrees per run (landed — ADR-010); usage/cost normalization and token/cost budgets; the `claude` adapter (`pi` was pulled forward with the quick start and is fixture-validated; the model-auth pre-spawn gate also landed early — see ADR-007); creation-time preflight; a tick admission cap (resume at most K live supervisors per tick, oldest first; the rest stay parked until a later tick — a budget, not a scheduler); the `plan-implement` loop with predecessor defaults; `redo`, `gc`, `watch`.

**M2 — team surface.** The `github` surface is built into core (§10.3, ADR-012) and the multi-persona workflow ships as the `ai-engineer` loop library — templates and a loop that users copy and adapt (ADR-011); remaining: hardened env profiles and publication steps; `openhands` adapter; predecessor-system migration guide.

**M3 — ecosystem.** Trace exporters (OTel / Braintrust / LangSmith / Laminar scripts); static HTML trace viewer generated from ledger + raw; `etium-mcp` extension. (The loop-authoring guide — `WRITING_LOOPS.md` — landed early, ahead of the first loop package.)

---

## 14. Open items

1. **Config-as-code** (`etium.config.ts`, evaluated to a plain object, core-only) — working position, confirm at M0.
2. `redo` / `step.invalidated` fine print (M1).
3. ~~Run-ID format and collision handling~~ — settled at M0: `YYYY-MM-DD-<goal-slug>-<rand4>`; prefix matching in the CLI.
4. ~~npm name~~ — settled twice: the project is **Etium**; GitHub org `etium-dev` is held. npm's typosquat guard rejects the bare name (`etium` is too similar to `cesium`), so the package is **`@etium/core`** under the `etium` npm org — mirroring `github.com/etium-dev/core`, with the scope housing future artifacts (`@etium/mcp`). The CLI command remains `etium` (the `bin` name is independent of the package name).
5. ~~License~~ — settled: MIT (LICENSE in repo), matching Pi and OpenHands.
6. The `codex` adapter parser is provisional pending real fixture capture (`scripts/capture-fixtures.sh`); harden and de-flag in M0 before the dogfooding exit criterion.

---

## Appendix A — Predecessor migration map

| AI_ENGINEER_STATE_MACHINE concept | Etium equivalent |
|---|---|
| Personas (Intake Analyst, Architect, …) | Prompt template files owned by the loop |
| Lifecycle states (PlanLoop, PlanReady, …) | Position in loop code + open gates — derived from the ledger, never stored |
| Command labels (`ai-plan`, `ai-implement`) | Gate decisions via the GitHub surface; consumed-once and one-command semantics preserved |
| `ai-running` + status comments | Idempotent projections of the ledger |
| Heartbeats, watchdog, reconciliation | Supervisor lockfile + `etium tick` |
| Queued blind spot | Eliminated — the supervisor runs where compute runs; Actions is at most a thin trigger calling `etium run`/`tick` |
| Convergence rules, escalation reports | Reference-loop logic emitting a `needs-human` gate with a report artifact |
| Unique branch per attempt | Worktree + branch per run |
| Controller/agent credential boundary | Env profiles (`agent` vs `host`; named `publish` profile with config-as-code) |
| Feedback snapshot at stage start | Gate-note injection at step start; `task.md` immutable per run |

## Appendix B — References

- Pi: https://pi.dev — minimal harness philosophy; extensions as ordinary code.
- Addy Osmani, "Loop Engineering": https://addyo.substack.com/p/loop-engineering — five building blocks + external memory; maker/checker split.
- Aishwarya Srinivasan, "All You Need To Know About Loop Engineering": https://aishwaryasrinivasan.substack.com/p/all-you-need-to-know-about-loop-engineering — loop anatomy; gates and stopping criteria; human context advantage.
- OpenHands Software Agent SDK (MLSys 2026): https://arxiv.org/abs/2511.03690 — event-sourced state with deterministic replay, validated in production.
- Geoffrey Huntley, Ralph: https://ghuntley.com/ralph/ and https://ghuntley.com/loop/ — the minimal outer loop; fresh context per iteration.

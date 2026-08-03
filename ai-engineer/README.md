# ai-engineer

**New here? Start with [TUTORIAL.md](TUTORIAL.md)** — zero to a working AI
engineer, including a token-free dry run. This file is the reference.
**Having an AI agent do the install? Give it [AGENT_INSTALL.md](AGENT_INSTALL.md)**
— deterministic steps, a PASS criterion per step, stop-on-fail.

The multi-persona, human-gated engineering workflow as an etium **loop
library**: `loop.ts` + `templates/` + this contract. `etium clone-loop ai-engineer` puts it in
your repo; adapt it — the templates are the product. The loop is
**surface-agnostic and CLI-complete** — the test suite drives the entire
state graph with `etium decide` alone; GitHub is a skin, provided by etium's
built-in `github` surface (DESIGN §10.3).

## The loop's contract

**Params** (all optional):

| param | meaning | default |
|---|---|---|
| `harness` | harness for persona steps | `pi` |
| `model` | passed through to the harness | harness default |
| `rounds` | builder/reviewer rounds per stage before escalating | `2` |
| `check` | shell command proving the implementation | `true` |
| `wall` | per-step wall budget | `2h` |
| `cmd.<step>` | dry-run hook: with `--harness exec`, scripts that step | — |

**Gates**:

| gate | opens | options |
|---|---|---|
| `route` | after triage, and after every stage | `triage · debug · design · plan` — `implement` appears once a plan converged; `wrap-up` once implementation converged |
| `<stage>-stuck` | reviewer still objects after `rounds` rounds | `keep-going · accept · wrap-up` |

Routing is fail-closed by construction: `implement` is not a declinable
request — it simply isn't offered until a plan exists.

**Artifacts** (in `ai/` on the run's branch): `INTAKE.md`, `DIAGNOSIS.md`,
`DESIGN.md`, `PLAN.md`, `REPORT.md`, and `REVIEW.md` (reviewer verdict —
first line `VERDICT: approve|revise`, stable objection keys).

The loop publishes nothing — it commits to its branch and opens gates. The
surface projects branch → draft PR → status comment → labels.

## Running it from the terminal (no GitHub)

```sh
etium run "fix the flaky auth test" --loop ai-engineer/loop.ts --worktree \
  --param check="npm test"
etium gates                     # → route: triage · debug · design · plan
etium decide <run> route plan --note "start with the retry"
```

## Running it against GitHub

Etium's built-in `github` surface drives any loop; this library is just what
you point it at. Configuration is env vars — no secrets among them; GitHub
auth is `gh`'s, model auth is the harness's
([MODEL_AUTH.md](../MODEL_AUTH.md)):

| var | meaning | default |
|---|---|---|
| `ETIUM_GH_REPO` | `owner/name` (**required**) | — |
| `ETIUM_GH_TRUSTED` | comma-separated logins allowed to command (**required**) | — |
| `ETIUM_GH_LOOP` | loop to run per task (**required**) — point it here | — |
| `ETIUM_GH_AGENT` | login whose *assignment* starts an attempt | authenticated user |
| `ETIUM_GH_WORKDIR` | checkout to branch worktrees from | cwd |
| `ETIUM_GH_BASE` | PR base branch | `main` |

The whole deployment, either mode, is one scheduled tick — `etium init
--wakeup cron` installs it platform-correctly: a **launchd agent** on macOS
(the scheduler context that can read gh's keychain-stored token — cron
runs in a different audit session and cannot; ADR-018), a crontab line on
Linux:

```
* * * * *  cd /path/to/checkout && ETIUM_GH_REPO=acme/widgets ETIUM_GH_TRUSTED=you \
           ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github
```

*Mode A (you, your machine)*: your `gh` auth, your harness login, done.
*Mode B (separate AI-engineer box)*: same line on that machine, with the bot
account's `gh` auth and the harness authenticated there; give the bot
**Write** (never admin), protect the default branch, and it can only ever
open draft PRs — the AI never merges.

**Protocol** (append-only events in, idempotent projections out — never
labels as commands):

- Assigning `ETIUM_GH_AGENT` to an issue (by a trusted user) starts an
  attempt: a worktree run on `etium/issue-N-attempt-K`. Re-assignment after
  an abandoned attempt starts attempt K+1 on a fresh branch.
- Commands are comments: `/et <option> [note]` (or `@<agent> <option>`) by a
  trusted author — the option is matched against whichever open gate
  declares it, validated fail-closed by core. `/et stop` abandons.
- The bot's status comment on the issue always lists the currently-valid
  commands. Labels `et:working|waiting|blocked` are decoration for issue
  lists; nothing ever reads them back.
- Closing the issue abandons the attempt; closing the PR unmerged abandons
  it; merging the PR completes it (or ends it as a human override earlier).

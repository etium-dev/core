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
| `directive` | the operator's kickoff words — the interpreter maps them to a stage and the loop goes straight there; unclear parks at the route gate with the question shown | — |
| `harness.<step>` / `model.<step>` | per-persona override — e.g. `harness.implement=codex`, `model.design=…` | the loop-wide `harness`/`model` |
| `cmd.<step>` | dry-run hook: with `--harness exec`, scripts that step | — |

Deployment defaults for any of these live in `.etium/config.json` under
`params` — `etium configure` asks for the default `harness` and validates
every harness the params reference; per-persona keys you edit in. Config
params merge under a run's own values, so explicit flags, surface params,
and task fields always win.

**Gates**:

| gate | opens | options |
|---|---|---|
| `route` | at kickoff (unless the directive already routed), and after every stage | `debug · design · plan · consider` — `implement` appears once a plan converged; `wrap-up` once implementation converged |
| `<stage>-stuck` | reviewer still objects after `rounds` rounds | `keep-going · accept · wrap-up · consider` — carries a `reason` and shows REVIEW.md first; on GitHub it arrives as its own persistent comment |

Routing is fail-closed by construction: `implement` is not a declinable
request — it simply isn't offered until a plan exists. `consider` is the
freestyle door: its note carries the operator's own words, and an
interpreter persona maps them to one of the other options — or writes a
clarifying question to `ai/REPLY.md` and re-opens the gate. It never
guesses.

**Artifacts** (in `ai/` on the run's branch): `DIAGNOSIS.md`, `DESIGN.md`,
`PLAN.md`, `REPORT.md`, and `REVIEW.md` (reviewer verdict — first line
`VERDICT: approve|revise`; only blockers force revise, under stable keys
with a `Resolved since last review:` accounting line; non-blocking notes
ride under an approve — the convergence contract's evidence is in
[REVIEW_CONVERGENCE.md](REVIEW_CONVERGENCE.md)). `ai/REPLY.md` is the
interpreter's working state (its reading of a freestyle message, or its
question back) — shown at the gate, never committed on its own.

The loop publishes nothing — it commits to its branch and opens gates. The
surface projects branch → draft PR → appended narration comments → labels.

## Running it from the terminal (no GitHub)

```sh
etium run "fix the flaky auth test" --loop ai-engineer/loop.ts --worktree \
  --param check="npm test"
etium gates                     # → route: debug · design · plan · consider
etium decide <run> route plan --note "start with the retry"
etium decide <run> route consider --note "just make it stop flaking"  # freestyle
```

## Running it against GitHub

Etium's built-in `github` surface drives any loop; this library is just what
you point it at. The deployment acts as this repository's own gh sign-in
(created by `etium configure`, stored under `.etium/gh`); anyone with
**Write** on the repository commands it. Configuration is env vars — no
secrets among them; model auth is the harness's
([MODEL_AUTH.md](../MODEL_AUTH.md)):

| var | meaning | default |
|---|---|---|
| `ETIUM_GH_REPO` | `owner/name` (**required**) | — |
| `ETIUM_GH_LOOP` | loop to run per task (**required**) — point it here | — |
| `ETIUM_GH_WORKDIR` | checkout to branch worktrees from | cwd |
| `ETIUM_GH_BASE` | PR base branch | `main` |

The whole deployment is one scheduled tick — `etium configure --wakeup
cron` installs it platform-correctly (a launchd agent on macOS, a crontab
line on Linux):

```
* * * * *  cd /path/to/checkout && ETIUM_GH_REPO=acme/widgets \
           ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github
```

A dedicated AI-engineer box is the same setup with a bot account's token
pasted at configure time: give the bot **Write** (never admin), protect
the default branch, and it can only ever open draft PRs — the AI never
merges.

**Protocol** (append-only events in, idempotent projections out — never
labels as commands):

- A `/et <anything>` comment on an open issue (by anyone with Write, when
  no attempt is active) starts one: a worktree run on
  `etium/issue-N-attempt-K`. The words after `/et` ride in as the
  `directive` — `/et fix this` routes straight into debug or plan without
  a confirmation gate. A later `/et` comment after an abandoned attempt
  starts attempt K+1 on a fresh branch.
- Commands are comments: `/et <option> [note]` (or `@<agent> <option>`) by
  anyone with Write — an exact option match decides whichever open gate
  declares it, validated fail-closed by core. Anything else is delivered
  as `consider` with your full text: the interpreter maps it to the
  vocabulary or asks you to rephrase. `/et stop` abandons.
- The bot narrates state changes as appended comments — stage
  transitions, gate openings (with the currently-valid commands, "just
  say what you want" when freestyle is open, the shown artifact's key
  points, and a link to the file on the branch), decisions, completion.
  Comments are never edited; the thread is the run's history. Labels
  `et:working|waiting|blocked` are decoration for issue lists; nothing
  ever reads them back.
- Closing the issue abandons the attempt; closing the PR unmerged abandons
  it; merging the PR completes it (or ends it as a human override earlier).

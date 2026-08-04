# Tutorial: an AI engineer for your repository

Etium setup is four questions — the same ones an agent asks on the agent
path (https://etium.dev/agent-install.txt): **which repo**; **etium only or
with the ai-engineer loop library** (this tutorial is the library path —
Part 0 clones it); **GitHub wiring or terminal only** (Parts 1–2 are
terminal; Part 3 wires GitHub, and you can stop before it); and **where
throwaway work may go** (yours to pick when testing).

This walks you from zero to a working AI engineer: first a five-minute
token-free dry run in your terminal, then real model runs, then wired to
GitHub — where assigning an issue produces a draft PR whose every stage you
command with comments and approve through gates. Nothing here requires a
server, a daemon, or an API key handed to anything: etium supervises,
harnesses bring their own auth, `gh` brings yours.

## 0. Install

```sh
curl -fsSL https://etium.dev/install.sh | sh
cd /path/to/your-repo
etium clone-loop ai-engineer
```

(`etium configure` does Part 0's setup and Part 3's wiring questions
interactively — checks with fix commands first, then the questions. The
manual steps below show exactly what it does.)

The library is a plain folder — a 97-line loop, seven persona prompts, and
a README with the exact contract. Cloning it into your repo is the intended
move: the templates are *yours to edit*, and the folder has no dependencies
(type imports only — it runs anywhere). The GitHub integration is not in
the folder at all: it's etium's built-in `github` surface, which drives any
loop you point it at.

You'll also want at least one coding harness installed and logged in —
[pi](https://pi.dev) (`pi`, then `/login`), Claude Code, or Codex. Etium
never sees those credentials; see `MODEL_AUTH.md` in the etium repo.

## 1. Dry run: learn the workflow for zero tokens

The loop has a scripting hook: under `--harness exec`, a `--param
cmd.<step>=…` shell command stands in for each persona. Fake personas, real
workflow — every gate, option, and artifact is the real thing:

```sh
cd /path/to/your-repo
etium run "Add input validation to the signup form" \
  --loop ai-engineer/loop.ts --worktree --harness exec --param rounds=1 \
  --param cmd.triage='mkdir -p ai && echo "recommend: plan" > ai/INTAKE.md' \
  --param cmd.plan='echo "1. validate email" > ai/PLAN.md' \
  --param cmd.plan-review='printf "VERDICT: approve\n" > ai/REVIEW.md' \
  --param cmd.implement='echo done > ai/REPORT.md' \
  --param cmd.implement-review='printf "VERDICT: approve\n" > ai/REVIEW.md'
```

The triage persona runs, then the run **parks** — zero processes — at its
first gate:

```
$ etium gates
2026-…-add-input-validation-…  route.0  show: ai/INTAKE.md
  → etium decide 2026-… route <triage|debug|design|plan>
```

That's the routing gate. Notice what it *doesn't* offer: `implement`.
Options appear as stages earn them. Decide, with guidance:

```sh
etium decide <run> route plan --note "email format only, no phone"
```

Your note is injected into the planner's prompt. The plan stage runs its
builder/reviewer rounds, then the route gate reopens — now offering
`implement`, showing `ai/PLAN.md` as evidence. Route through `implement`,
then `wrap-up`, and read the whole story:

```
$ etium tail <run> --once
gate ? route.0  awaiting decision  options=triage|debug|design|plan  show=ai/INTAKE.md
gate ◆ route.0  plan by you (cli) — email format only, no phone
gate ? route.1  awaiting decision  options=…|plan|implement  show=ai/PLAN.md,ai/REVIEW.md
gate ◆ route.1  implement by you (cli)
gate ? route.2  awaiting decision  options=…|implement|wrap-up  show=ai/REPORT.md,ai/REVIEW.md
gate ◆ route.2  wrap-up by you (cli)
run DONE
```

Because of `--worktree`, all of it happened on branch `etium/<run-id>` in
its own checkout under `.etium/worktrees/` — your working tree was never
touched, and `ai/INTAKE.md`, `ai/PLAN.md`, `ai/REPORT.md`, `ai/REVIEW.md`
sit on that branch as the audit trail. Every prompt, stream, and decision
is under `.etium/runs/<run>/`; `grep` works on all of it.

## 2. Real personas

Drop the `cmd.*` params and the harness default takes over (`pi`; use
`--harness claude`, `--harness codex`, or `--param model=…` as you like):

```sh
etium run "Add input validation to the signup form" \
  --loop ai-engineer/loop.ts --worktree --param check="npm test"
```

Now triage actually reads your repo and writes a real recommendation into
`ai/INTAKE.md`, reviewers actually object (`VERDICT: revise` with stable
objection keys — the builder must address them next round), and
`implement` must pass **both** its reviewer and your `check` command. When
a reviewer still objects after `rounds` rounds (default 2), you get a
`<stage>-stuck` gate: `keep-going`, `accept`, or `wrap-up`. Walk away at
any gate; `kill -9` anything; `etium tick` from cron reconciles. That's the
operating model: the AI works, parks, and waits for you.

## 3. Wire it to GitHub

Now the same loop, commanded from issues instead of the terminal. On the
machine that will run the work (your laptop is fine): `etium configure`,
choose **Wire up GitHub**. It creates this repository's own gh sign-in
(stored under `.etium/gh` — the machine's personal gh account is never
touched) and installs or prints the always-on wake-up. Anyone GitHub lets
push to the repository (Write) can command the engineer.

Trying it out? Skip always-on — run the tick in the foreground while you
play (`Ctrl-C` to stop; nothing is installed):

```sh
ETIUM_GH_REPO=you/your-repo ETIUM_GH_LOOP=ai-engineer/loop.ts \
  etium watch --surface github
```

Then, on GitHub:

1. **Assign yourself** (or the configured agent user) to an issue. Within a
   minute, the surface creates a run on branch `etium/issue-N-attempt-0`,
   triage runs, and a status comment appears on the issue telling you
   exactly what it's waiting for and which commands are valid.
2. **Command with comments.** `/et plan start with the retry logic` — the
   word is matched against the open gate's declared options, your text
   becomes the note, and anyone without Write is ignored.
3. **Review the draft PR.** As soon as a stage produces artifacts, the
   surface pushes the branch and opens one draft PR. The `ai/` documents
   and the commits are the reviewable work.
4. **Finish on GitHub's own terms.** Merging the PR ends the run. Closing
   the PR or the issue abandons the attempt. `/et stop` abandons it with
   your note as the reason. Re-assigning later starts attempt #1 on a
   fresh branch — abandoned work never blocks a retry.

The `et:working` / `et:waiting` / `et:blocked` labels are decoration for
your issue list (`label:et:waiting` = "waiting on me"); nothing ever reads
them back, so they can't lie for long — the next tick corrects them.

## 4. The always-on engineer (separate machine, separate identity)

Same package, same setup — the only difference is whose token you paste.
On a spare machine:

1. Create a **bot GitHub account**; give it **Write** on the repo (never
   admin), protect your default branch, require reviews. The bot only ever
   opens draft PRs; merging stays yours.
2. Install etium, clone your repo, run `etium configure`: sign the
   deployment in with a token for the bot (classic `repo` scope — a
   collaborator's fine-grained token can't reach another owner's private
   repo), and log the harness in (`pi` → `/login`).

Now **assigning the bot** to an issue starts an attempt, and you interact
entirely through issue comments and PR reviews from anywhere. If the
machine goes offline, nothing lies — runs park, status freezes, and the
next tick after it returns reconciles everything. Full env-var reference
and the loop's params/gates/artifacts contract: [README.md](README.md).

## 5. Make it yours

- **Edit the personas.** `templates/*.md` are plain markdown — team
  conventions belong in `conventions.md`, stage behavior in each persona.
  Editing a template mid-run fails loudly rather than silently replaying
  stale work; finish or abandon runs first.
- **Tune the knobs.** `--param rounds=3`, `--param wall=30m`, `--param
  check="make test"`, per-run `--harness`/`--param model=…`.
- **Change the workflow itself.** The loop is 97 lines of ordinary
  TypeScript — add a stage, change an option set, split a persona. The
  loop-authoring guide (`WRITING_LOOPS.md`) is the manual; the surface
  needs no changes, because it matches commands against whatever options
  your gates declare.

## Troubleshooting

- **Nothing happens after assigning an issue** — the wake-up isn't
  running, the deployment isn't signed in (re-run `etium configure`), or
  the assigner doesn't have Write (ignored by design). Run the tick
  command by hand and read its output.
- **Your `/et` comment did nothing** — you don't have Write on the
  repository, or the word isn't among the open gate's options; the status
  comment always lists the valid set. Decisions fail closed, silently on
  the invalid side.
- **The run errored about harness auth** — the harness on the executing
  machine isn't logged in; the error names the exact remedy (e.g. `pi`
  then `/login`). Fix and `etium resume <run>` — completed steps replay
  from the ledger, nothing reruns.
- **You want to see what the model actually did** — `etium tail <run>`,
  or open `.etium/runs/<run>/steps/*/` for the exact prompt and the full
  raw stream of every step.

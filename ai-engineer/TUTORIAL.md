# Tutorial: an AI engineer for your repository

This walks you from zero to a working AI engineer: first a five-minute
token-free dry run in your terminal, then real model runs, then wired to
GitHub — where assigning an issue produces a draft PR whose every stage you
command with comments and approve through gates. Nothing here requires a
server, a daemon, or an API key handed to anything: etium supervises,
harnesses bring their own auth, `gh` brings yours.

## 0. Install

```sh
npm install -g @etium/core        # Node ≥ 22.18
cd /path/to/your-repo
etium clone-loop ai-engineer      # → ./ai-engineer, yours to edit
```

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
machine that will run the work (your laptop is fine):

```sh
gh auth status        # gh must be authenticated for the target repo
```

Add one cron line (this *is* the deployment):

```
* * * * *  cd /path/to/your-repo && \
  ETIUM_GH_REPO=you/your-repo ETIUM_GH_TRUSTED=your-login \
  ETIUM_GH_LOOP=ai-engineer/loop.ts \
  etium tick --surface github >> .etium/tick.log 2>&1
```

Then, on GitHub:

1. **Assign yourself** (or the configured agent user) to an issue. Within a
   minute, the surface creates a run on branch `etium/issue-N-attempt-0`,
   triage runs, and a status comment appears on the issue telling you
   exactly what it's waiting for and which commands are valid.
2. **Command with comments.** `/et plan start with the retry logic` — the
   word is matched against the open gate's declared options, your text
   becomes the note, and anyone not in `ETIUM_GH_TRUSTED` is ignored.
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

Same package, same cron line, different credentials — that's the entire
difference. On a spare machine:

1. Create a **bot GitHub account**; give it **Write** on the repo (never
   admin), protect your default branch, require reviews. The bot only ever
   opens draft PRs; merging stays yours.
2. `gh auth login` as the bot; log the harness in (`pi` → `/login`) on that
   machine.
3. Install etium, clone your repo, add the cron line with
   `ETIUM_GH_AGENT=<bot-login>` and `ETIUM_GH_TRUSTED=<your-login>`.

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

- **Nothing happens after assigning an issue** — cron isn't running the
  tick line, `gh` isn't authenticated on that machine, or the assigner
  isn't in `ETIUM_GH_TRUSTED` (assignments by untrusted users are ignored
  by design). Run the tick command by hand and read its output.
- **Your `/et` comment did nothing** — you're not in `ETIUM_GH_TRUSTED`,
  or the word isn't among the open gate's options; the status comment
  always lists the valid set. Decisions fail closed, silently on the
  invalid side.
- **The run errored about harness auth** — the harness on the executing
  machine isn't logged in; the error names the exact remedy (e.g. `pi`
  then `/login`). Fix and `etium resume <run>` — completed steps replay
  from the ledger, nothing reruns.
- **You want to see what the model actually did** — `etium tail <run>`,
  or open `.etium/runs/<run>/steps/*/` for the exact prompt and the full
  raw stream of every step.

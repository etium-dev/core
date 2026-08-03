# AGENT_INSTALL — setting up etium (instructions for an AI agent)

You are an AI agent setting up etium for a repository — the CLI, and
optionally a loop library. Follow these steps in order. Every step ends with a
**Verify** command and a **PASS** criterion; if a criterion is not met,
**stop and report** the step number and the command output — do not
improvise a fix, do not continue.

## Step 0 — interview the operator

Do not start until every question below has an answer. Ask **all applicable
questions in one message** (never drip them one at a time), offering the
defaults shown; skip any question the operator's handoff message already
answered. Then restate the resulting configuration in one line and proceed —
e.g. "Configuration: repo /a/b, etium only, no GitHub wiring, scratch in a
temp dir. Starting."

1. **Which repository should etium work in?** (absolute path → `REPO_DIR`)
2. **Etium only, or also the ai-engineer loop library?** Cloning the
   library commits an `ai-engineer/` folder into the repo — never assume
   it. (`LIBRARY` = `ai-engineer` or `none`)
3. **Wire it to GitHub, so assigning an issue starts work and `/et`
   comments drive it?** If yes, ask the follow-ups below **in these plain
   phrasings — never surface the raw input names** (a newcomer has no idea
   what a "trusted login" is):
   - "Which GitHub repository? (`owner/name`)" → `GITHUB_REPO`
   - "What is **your** GitHub username? The engineer only obeys comments
     and assignments from usernames on this list — start with just
     yourself; teammates can be added later." → `TRUSTED`
   - "Should the engineer act **as you**, or as a **separate bot
     account**? As-you is the simple start: assigning yourself to an
     issue kicks it off. If a bot, what is its username?" (default: the
     `gh`-authenticated user) → `AGENT_LOGIN`
   - "Install the every-minute cron line now, or just print it for you?"
     → `INSTALL_CRON`

   If no, step 4 is skipped.
4. **Any constraints on where throwaway verification work may happen?**
   (default: a fresh `mktemp -d` directory → `SCRATCH_DIR`)

The answers bind these inputs, referenced by the steps below:

| input | required | meaning |
|---|---|---|
| `REPO_DIR` | yes | absolute path of the target repository checkout |
| `GITHUB_REPO` | no | `owner/name` to wire the GitHub surface; omit for terminal-only install |
| `TRUSTED` | if `GITHUB_REPO` | comma-separated GitHub logins allowed to command the engineer |
| `AGENT_LOGIN` | if `GITHUB_REPO` | GitHub login whose issue-assignment starts an attempt |
| `INSTALL_CRON` | if `GITHUB_REPO` | `yes` to add the crontab entry; anything else = print it only |
| `SCRATCH_DIR` | no | writable directory for throwaway verification work; default: a fresh `mktemp -d` directory |
| `LIBRARY` | **ask if omitted** | `ai-engineer` to clone the loop library into the repo, or `none` for etium only. Cloning writes a commit into the repo — never assume it |

## Rules

- Make no changes outside `REPO_DIR` except: the global npm install
  (step 1), the throwaway directory in step 4, and — only when
  `INSTALL_CRON=yes` — one crontab line.
- **Never run `sudo`** and never download OS installers. When a step needs
  elevation (system Node, root-owned npm prefix), stop and print the exact
  command for the operator to run themselves.
- Do not run interactive authentication (`gh auth login`, `pi` `/login`,
  browser flows) and do not create accounts. If auth is missing, report it
  as the operator's remaining step.
- All throwaway work happens under `SCRATCH_DIR` (set
  `SCRATCH_DIR="${SCRATCH_DIR:-$(mktemp -d)}"` once at the start) — never a
  hardcoded path.
- Do not edit anything under `ai-engineer/` during install; customization
  is a separate, later task.
- All verification is by exit code or by the stated string being present.
  Run IDs and dates vary; never compare them exactly.

## Step 1 — etium on PATH

Preconditions first:

```sh
node --version && npm --version
```

**PASS**: both print; Node major ≥ 22 (`v22.18` minimum). If Node or npm is
missing or too old, **stop and report**: "operator must install Node ≥
22.18 (nodejs.org installer or a package manager)". Do not download or run
installers yourself.

```sh
etium --version
```

**PASS**: prints a version — skip to Step 2. If the command is missing:

```sh
npm install -g @etium/core
```

Classify a failure by its error, and do not substitute one remedy for the
other:

- **Permission error** (`EACCES`/`EPERM`, typically a root-owned
  `/usr/local` from a system Node): **stop and report** both operator
  fixes verbatim — run `sudo npm install -g @etium/core`, **or** configure
  a user-owned prefix (`npm config set prefix ~/.npm-global` and add
  `~/.npm-global/bin` to PATH, then re-run without sudo). Do not use the
  source fallback: `npm link` lands in the same root-owned prefix.
- **Any other failure** (404, network, registry error): **stop and
  report** the verbatim output. There is no alternate install path — the
  npm tarball is the only artifact that passes release verification, and a
  registry outage is the operator's to wait out, not yours to engineer
  around.

**Verify**: `etium --version` → prints a version. Otherwise stop and report.

## Step 2 — copy the package into the repository

```sh
cd "$REPO_DIR"
test -d .git                       # PASS: exit 0 (it is a git repo)
test ! -e ai-engineer              # PASS: exit 0 (no collision; if it exists, stop and report)
etium clone-loop ai-engineer       # PASS: exit 0; also appends .etium/ to .gitignore
git add ai-engineer .gitignore
git commit -m "Add etium ai-engineer loop library"
```

**Verify**: `test -f ai-engineer/loop.ts && grep -qx '.etium/' .gitignore && ls ai-engineer/templates/*.md | wc -l` →
both tests exit 0 and the count is `7`.

## Step 3A — acceptance test with the library (only if `LIBRARY=ai-engineer`)

This proves the install without touching `REPO_DIR`'s state and without any
model or GitHub access. Run exactly:

```sh
git clone -q "$REPO_DIR" "$SCRATCH_DIR/etium-verify" && cd "$SCRATCH_DIR/etium-verify"
etium run "verify install" --loop ai-engineer/loop.ts --worktree --harness exec --param rounds=1 \
  --param cmd.triage='mkdir -p ai && echo ok > ai/INTAKE.md' \
  --param cmd.plan='echo plan > ai/PLAN.md' \
  --param cmd.plan-review='printf "VERDICT: approve\n" > ai/REVIEW.md' \
  --param cmd.implement='echo done > ai/REPORT.md' \
  --param cmd.implement-review='printf "VERDICT: approve\n" > ai/REVIEW.md' \
  --sync
```

**PASS**: last line is `outcome: parked`.

```sh
etium gates
```

**PASS**: output contains `route <triage|debug|design|plan>` (note:
`implement` must NOT be listed yet — its absence is part of the test).

```sh
etium decide verify route plan --sync      # PASS: ends with `outcome: parked`
etium decide verify route implement --sync # PASS: ends with `outcome: parked`
etium decide verify route wrap-up --sync   # PASS: ends with `outcome: done`
```

Cleanup: `rm -rf "$SCRATCH_DIR/etium-verify"`. If every PASS held, the
setup is functional. If `GITHUB_REPO` was not provided, go to Step 5.

## Step 3B — acceptance test, etium only (only if `LIBRARY=none`)

Entirely in scratch; nothing touches `REPO_DIR`:

```sh
mkdir -p "$SCRATCH_DIR/etium-verify" && cd "$SCRATCH_DIR/etium-verify"
printf 'export default async function (run) {\n  await run.step("greet", { harness: "exec", command: "echo hello > hello.txt" });\n  const d = await run.gate("publish?", { show: ["hello.txt"] });\n  await run.step("publish", { harness: "exec", command: `echo done by ${d.by} > done.txt` });\n}\n' > hello.ts
etium run "verify" --loop hello.ts --sync
```

**PASS**: last line is `outcome: parked`.

```sh
etium approve verify "publish?" --sync
```

**PASS**: last line is `outcome: done`. Cleanup:
`rm -rf "$SCRATCH_DIR/etium-verify"`. If `GITHUB_REPO` was not provided, go
to Step 5.

## Step 4 — GitHub wiring (only if `GITHUB_REPO` is set)

```sh
gh auth status
```

**PASS**: exit 0. On failure, stop; report "operator must run `gh auth
login` on this machine" as a remaining step — do not run it yourself.

```sh
gh api "repos/$GITHUB_REPO" --jq .permissions.push
```

**PASS**: prints `true` (the authenticated account can push). Then run one
tick by hand:

```sh
cd "$REPO_DIR" && ETIUM_GH_REPO="$GITHUB_REPO" ETIUM_GH_TRUSTED="$TRUSTED" \
  ETIUM_GH_AGENT="$AGENT_LOGIN" ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github
```

**PASS**: exit 0, and output is either `no runs` or a list of per-run
action lines. Any `surface-error` line: stop and report it verbatim.

Crontab entry (one line; substitute the real values):

```
* * * * * cd REPO_DIR && ETIUM_GH_REPO=… ETIUM_GH_TRUSTED=… ETIUM_GH_AGENT=… ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github >> .etium/tick.log 2>&1
```

If `INSTALL_CRON=yes`: install it idempotently —

```sh
( crontab -l 2>/dev/null | grep -v 'etium tick --surface github'; \
  echo '* * * * * cd '"$REPO_DIR"' && ETIUM_GH_REPO='"$GITHUB_REPO"' ETIUM_GH_TRUSTED='"$TRUSTED"' ETIUM_GH_AGENT='"$AGENT_LOGIN"' ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github >> .etium/tick.log 2>&1' ) | crontab -
crontab -l | grep -c 'etium tick --surface github'
```

**PASS**: the final count is `1`. Otherwise (or if `INSTALL_CRON` is not
`yes`): print the crontab line in your report for the operator to install.

## Step 5 — report

End with a report to your operator containing exactly:

1. Each step number with **PASS / FAIL / SKIPPED** — for any FAIL, the
   verbatim output; for any SKIPPED, the gating input that caused it
   (e.g. `SKIPPED — GITHUB_REPO not provided`, `SKIPPED — LIBRARY=none`).
   Never invent other status words.
2. The commit hash created in Step 2 (only when `LIBRARY=ai-engineer`).
3. Remaining manual steps, chosen from: authenticate `gh` on this machine;
   authenticate a harness (e.g. `pi` then `/login`) before real-persona
   runs; install the printed crontab line; assign `AGENT_LOGIN` to a GitHub
   issue to start the first attempt.
4. Nothing else — no summaries of what the package "will" do, no edits you
   "recommend". Install reports state what was verified.

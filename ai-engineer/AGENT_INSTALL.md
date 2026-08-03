# AGENT_INSTALL — installing the ai-engineer (instructions for an AI agent)

You are an AI agent installing the etium ai-engineer package into a
repository. Follow these steps in order. Every step ends with a
**Verify** command and a **PASS** criterion; if a criterion is not met,
**stop and report** the step number and the command output — do not
improvise a fix, do not continue.

## Inputs

Obtain these from your operator before starting. If any required input is
missing, ask; do not guess.

| input | required | meaning |
|---|---|---|
| `REPO_DIR` | yes | absolute path of the target repository checkout |
| `GITHUB_REPO` | no | `owner/name` to wire the GitHub surface; omit for terminal-only install |
| `TRUSTED` | if `GITHUB_REPO` | comma-separated GitHub logins allowed to command the engineer |
| `AGENT_LOGIN` | if `GITHUB_REPO` | GitHub login whose issue-assignment starts an attempt |
| `INSTALL_CRON` | if `GITHUB_REPO` | `yes` to add the crontab entry; anything else = print it only |

## Rules

- Make no changes outside `REPO_DIR` except: the global npm install
  (step 1), the throwaway directory in step 4, and — only when
  `INSTALL_CRON=yes` — one crontab line.
- Do not run interactive authentication (`gh auth login`, `pi` `/login`,
  browser flows) and do not create accounts. If auth is missing, report it
  as the operator's remaining step.
- Do not edit anything under `ai-engineer/` during install; customization
  is a separate, later task.
- All verification is by exit code or by the stated string being present.
  Run IDs and dates vary; never compare them exactly.

## Step 1 — etium on PATH

```sh
etium --version
```

**PASS**: prints a version (e.g. `0.1.0`). If the command is missing, run:

```sh
npm install -g @etium/core
```

If that fails (package not yet published or registry unreachable), install
from source:

```sh
git clone https://github.com/etium-dev/core /tmp/etium-src
cd /tmp/etium-src && npm install && npm run build && npm link
```

**Verify**: `etium --version` → prints a version. Also `node --version` →
major ≥ 22 (`v22.18` minimum). Otherwise stop and report.

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

## Step 3 — acceptance test (token-free, in a throwaway clone)

This proves the install without touching `REPO_DIR`'s state and without any
model or GitHub access. Run exactly:

```sh
git clone -q "$REPO_DIR" /tmp/etium-verify && cd /tmp/etium-verify
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

Cleanup: `rm -rf /tmp/etium-verify`. If every PASS held, the package is
installed and functional. If `GITHUB_REPO` was not provided, go to Step 5.

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
* * * * * cd REPO_DIR && ETIUM_GH_REPO=… ETIUM_GH_TRUSTED=… ETIUM_GH_AGENT=… ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github >> /tmp/etium-tick.log 2>&1
```

If `INSTALL_CRON=yes`: install it idempotently —

```sh
( crontab -l 2>/dev/null | grep -v 'etium tick --surface github'; \
  echo '* * * * * cd '"$REPO_DIR"' && ETIUM_GH_REPO='"$GITHUB_REPO"' ETIUM_GH_TRUSTED='"$TRUSTED"' ETIUM_GH_AGENT='"$AGENT_LOGIN"' ETIUM_GH_LOOP=ai-engineer/loop.ts etium tick --surface github >> /tmp/etium-tick.log 2>&1' ) | crontab -
crontab -l | grep -c 'etium tick --surface github'
```

**PASS**: the final count is `1`. Otherwise (or if `INSTALL_CRON` is not
`yes`): print the crontab line in your report for the operator to install.

## Step 5 — report

End with a report to your operator containing exactly:

1. Each step number with PASS/FAIL and, for any FAIL, the verbatim output.
2. The commit hash created in Step 2.
3. Remaining manual steps, chosen from: authenticate `gh` on this machine;
   authenticate a harness (e.g. `pi` then `/login`) before real-persona
   runs; install the printed crontab line; assign `AGENT_LOGIN` to a GitHub
   issue to start the first attempt.
4. Nothing else — no summaries of what the package "will" do, no edits you
   "recommend". Install reports state what was verified.

# ralph

The reference loop: one agent iterating against the same prompt, fresh
context every attempt, until an external check passes. The whole loop is
[loop.ts](loop.ts) — ~35 lines, meant to be read, and yours to edit:
`etium clone-loop ralph` put this folder in your repo.

The stopping criterion is never the model's own judgment. The loop ends
when `check` (a shell command you supply) exits 0, or it parks: after
`iterations` attempts it opens the `iteration-guard` gate and a human
decides. The prompt states the goal; the check defines done — the maker
never grades its own homework.

## Params (all optional)

| param | meaning | default |
|---|---|---|
| `prompt` | template file stating the goal | `PROMPT.md` |
| `check` | shell command; exit 0 ends the loop (omit = single pass) | — |
| `iterations` | agent attempts before the guard gate | `30` |
| `harness` | which agent runs each attempt | `codex` |
| `model` | passed through to the harness | harness default |
| `wall` | per-attempt wall budget | `2h` |
| `fixture`, `inner` | replay-harness testing (see WRITING_LOOPS.md) | — |

## Gates

| gate | opens | options |
|---|---|---|
| `iteration-guard` | after `iterations` attempts without a passing check | `approve` — another block of attempts; your `--note` reaches the next prompt · `reject` — abandon |

## Artifacts

None of its own. The work product is the workspace (the run's branch,
under `--worktree`) — whatever the agent built by the time the check
passed.

## Running it

```sh
echo "your goal, precisely stated" > PROMPT.md
etium run "your goal" --loop ralph/loop.ts --workspace . --param check="npm test"
```

(`--loop` defaults to `ralph/loop.ts`, so once this folder is cloned the
flag is optional.)

Each attempt is fresh context: the model remembers nothing between
attempts; progress accumulates in the files it leaves behind. Same prompt,
evolving workspace, objective referee, human circuit-breaker.

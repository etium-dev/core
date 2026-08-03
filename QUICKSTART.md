# Quick start

Two hello-worlds: one that runs offline in sixty seconds and shows you what
etium *is*, and one that drives a real coding agent (Pi).

## Setup

Node ≥ 22.18. Then:

```sh
curl -fsSL https://etium.dev/install.sh | sh
```

The installer checks Node and npm (offering to install Node if missing),
never uses sudo — it picks a user-writable location instead — and ends
with `etium` on PATH. Prefer plain npm? `npm install -g @etium/core`
does the same when your setup is already healthy.

(Permission error? Your Node is system-installed — the macOS .pkg
installer, or a Linux distro package — so its global prefix is root-owned.
Quick fix: `sudo npm install -g @etium/core`. Permanent fix: install Node
via Homebrew or a version manager and sudo is never needed again.)

Etium setup is four questions, the same ones an agent asks on the
[agent path](https://etium.dev/agent-install.txt): **which repo** (wherever
you run `etium`), **etium only or with the ai-engineer loop library** (this
page is etium only — the [tutorial](https://etium.dev/ai-engineer.html) is
the library path), **GitHub wiring or terminal only** (this page is
terminal only), and **where throwaway work may go** (yours to pick when
testing).

Prefer being walked through it? `etium init` checks your machine (each
missing dependency printed with the command that fixes it), asks the setup
questions with sensible defaults, and applies your answers.

## Hello world, offline — the shape of a run

Etium's whole model: a **loop** is a plain TypeScript file that sequences
**steps** (headless subprocesses) and **gates** (parks until a human decides).
No tokens, no model, no network needed to see it work — `exec` runs any
command as a step.

```ts
// hello.ts
export default async function (run) {
  await run.step("greet", { harness: "exec", command: "echo hello > hello.txt" });
  const d = await run.gate("publish?", { show: ["hello.txt"] });
  await run.step("publish", {
    harness: "exec",
    command: `echo "hello, ${d.by}" > published.txt`,
  });
}
```

```sh
etium run "say hello" --loop hello.ts
etium status
etium gates
```

`status` shows the run parked at the gate — no process is resident —
and `gates` shows what's waiting on you.

The run parked. Nothing is running — kill -9 anything you like. Now decide:

```sh
etium approve <run> "publish?" --note "ship it"
etium tail <run>
```

Everything that happened is files: `ls .etium/runs/<run>/` — `events.jsonl`
is the append-only ledger (authority for control flow), `steps/` holds each
step's exact prompt and raw stream, `decisions/` carried your approval.
`grep gate .etium/runs/*/events.jsonl` works. That's the product.

## Hello world with Pi — a real agent in the loop

[Pi](https://pi.dev) authenticates itself — etium never touches model
credentials (see `MODEL_AUTH.md`). One-time, per machine:

```sh
pi
```

(interactive — run `/login`, pick your provider, then quit)

(API-key users can skip the login: the pi adapter passes `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY` through from your
environment — values are redacted from everything etium writes to disk.)

Now give an agent a task under the `ralph` reference loop — clone it, then
iterate until the check passes:

```sh
mkdir hello-pi && cd hello-pi
etium clone-loop ralph
echo "Create hello.txt containing exactly: hello world" > PROMPT.md
etium run "pi says hello" --harness pi --workspace . \
  --param check="grep -q 'hello world' hello.txt" \
  --param iterations=3
etium tail <run>
```

(`--loop` defaults to `ralph/loop.ts` — the folder the clone just created.
`--workspace .` makes the current directory the step workspace — that's where
`PROMPT.md` is found and where the agent's files land. Omit it and each run
gets a fresh empty workspace under `.etium/runs/<run>/ws/`.)

The step's full model conversation is captured under
`.etium/runs/<run>/steps/001-iterate.0/` — `prompt.md` is exactly what was
sent, `raw.jsonl(.zst)` is exactly what came back. A word on failure: pi
ships no auth-status command and exits 0 even when the model call errors, so
etium can't refuse up front the way it does for harnesses with a check
command — instead the error surfaces as a message in `etium tail`
(e.g. `error: No API key for provider: …`), the check step fails, and ralph
iterates or parks at the guard. Authenticate (`pi` → `/login`) and
`etium resume <run>`.

## Where to go next

- **[WRITING_LOOPS.md](WRITING_LOOPS.md)** — the loop-authoring guide, built
  around a worked plan → approve → implement → escalate example.
- `ralph/loop.ts` is the whole reference loop — ~35 lines, already cloned
  into your repo and yours to edit; loops are just code.
- `DESIGN.md` for the contract; `PRODUCT.md` for why this exists.
- Budgets: add `--param wall=10m`, or write a loop with per-step
  `budget: { wall, tokens, costUsd }`.

# Quick start

Two hello-worlds: one that runs offline in sixty seconds and shows you what
etium *is*, and one that drives a real coding agent (Pi).

## Setup (from a checkout)

Node ≥ 22.18. Then:

```sh
npm install && npm run build && npm link    # gives you `etium` on PATH
```

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
etium status              # run is parked at the gate; no process is resident
etium gates               # what's waiting on you
```

The run parked. Nothing is running — kill -9 anything you like. Now decide:

```sh
etium approve <run> "publish?" --note "ship it"
etium tail <run>          # watch it resume, replay past the done step, finish
```

Everything that happened is files: `ls .etium/runs/<run>/` — `events.jsonl`
is the append-only ledger (authority for control flow), `steps/` holds each
step's exact prompt and raw stream, `decisions/` carried your approval.
`grep gate .etium/runs/*/events.jsonl` works. That's the product.

## Hello world with Pi — a real agent in the loop

[Pi](https://pi.dev) authenticates itself — etium never touches model
credentials (see `MODEL_AUTH.md`). One-time, per machine:

```sh
pi            # interactive; run /login and pick your provider, then quit
```

(API-key users can skip the login: the pi adapter passes `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENROUTER_API_KEY` through from your
environment — values are redacted from everything etium writes to disk.)

Now give an agent a task under the bundled `ralph` loop — iterate until the
check passes:

```sh
mkdir hello-pi && cd hello-pi
echo "Create hello.txt containing exactly: hello world" > PROMPT.md
etium run "pi says hello" --harness pi --workspace . \
  --param check="grep -q 'hello world' hello.txt" \
  --param iterations=3
etium tail <run>
```

(`--workspace .` makes the current directory the step workspace — that's where
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
- `loops/ralph.js` is the whole reference loop — ~35 lines. Copy it, edit it;
  loops are just code.
- `DESIGN.md` for the contract; `PRODUCT.md` for why this exists.
- Budgets: add `--param wall=10m`, or write a loop with per-step
  `budget: { wall, tokens, costUsd }`.

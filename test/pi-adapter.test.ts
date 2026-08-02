// pi adapter: build shape, auth declaration, and the parser validated against
// the captured fixtures under fixtures/pi/ (real error capture + synthetic
// success stream modeled on the real shapes). Tool-event shapes are still
// PROVISIONAL — extend when a tool-using capture lands (ADR-005 pattern).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "../src/adapters.ts";
import { runStep } from "../src/runner.ts";
import type { RunStepArgs } from "../src/engine.ts";
import type { HarnessEvent } from "../src/types.ts";

const pi = getAdapter("pi");
const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pi");
const fixtureLines = (name: string): string[] =>
  fs.readFileSync(path.join(fixturesDir, name), "utf8").split("\n").filter(Boolean);

test("pi: build pins the headless JSON invocation", () => {
  const b = pi.build({ prompt: "do the thing", model: "anthropic/claude-sonnet-4", workspace: "/w" });
  assert.equal(b.cmd, "pi");
  assert.deepEqual(b.args, ["-p", "--mode", "json", "--model", "anthropic/claude-sonnet-4", "do the thing"]);
  const noModel = pi.build({ prompt: "hi", workspace: "/w" });
  assert.deepEqual(noModel.args, ["-p", "--mode", "json", "hi"]);
});

test("pi: auth declaration names credential vars and the remedy", () => {
  assert.ok(pi.auth?.env?.includes("ANTHROPIC_API_KEY"));
  assert.ok(pi.auth?.remedy?.startsWith("pi"));
  assert.equal(pi.auth?.check, undefined); // pi ships no status subcommand (§10.2)
});

test("pi parser vs real capture: error turn surfaces, usage counted once, exit-0 lie exposed", () => {
  const events = fixtureLines("20260802T183953Z-error-no-key.jsonl").map((l) => pi.parse!(l));
  // line 2: agent_start; line 9: agent_end
  assert.deepEqual(events[1], [{ kind: "lifecycle", state: "started" }]);
  assert.deepEqual(events[8], [{ kind: "lifecycle", state: "exiting" }]);
  // user message_end (line 5) is ignored; assistant message_end (line 7) carries
  // the error and the (zero) usage — the only usage-bearing event in the stream.
  assert.equal(events[4], null);
  const assistant = events[6]!;
  assert.equal(assistant[0]!.kind, "message");
  assert.match((assistant[0] as { summary: string }).summary, /^error: No API key for provider/);
  assert.deepEqual(assistant[1], { kind: "usage", usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } });
  // session/turn_start/message_start/turn_end are raw-only
  for (const i of [0, 2, 3, 5, 7]) assert.equal(events[i], null, `line ${i + 1} should be raw-only`);
});

test("pi parser vs synthetic success: text + usage from message_end only", () => {
  const all = fixtureLines("synthetic.jsonl").flatMap((l) => pi.parse!(l) ?? []);
  const messages = all.filter((e) => e.kind === "message");
  const usage = all.filter((e) => e.kind === "usage") as Extract<HarnessEvent, { kind: "usage" }>[];
  assert.equal(messages.length, 1); // assistant only, despite turn_end/agent_end repeating it
  assert.match((messages[0] as { summary: string }).summary, /hello world/);
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0]!.usage, { tokensIn: 42, tokensOut: 12, costUsd: 0.0003 });
});

test("pi parser vs tool-use capture: one tool event, one text message, usage totals", () => {
  // Real stream captured BY etium (run 2026-08-02-pi-says-hello-brj7).
  const all = fixtureLines("20260802T185638Z-tool-use.jsonl").flatMap((l) => pi.parse!(l) ?? []);
  const tools = all.filter((e) => e.kind === "tool");
  assert.equal(tools.length, 1); // execution_start only; successful end is raw-only
  assert.equal((tools[0] as { name: string }).name, "write");
  assert.match((tools[0] as { summary: string }).summary, /hello\.txt/);
  const messages = all.filter((e) => e.kind === "message");
  assert.equal(messages.length, 1); // final assistant text; toolResult/user/deltas ignored
  const usage = all.filter((e) => e.kind === "usage") as Extract<HarnessEvent, { kind: "usage" }>[];
  const tokens = usage.reduce((s, u) => s + (u.usage.tokensIn ?? 0) + (u.usage.tokensOut ?? 0), 0);
  assert.equal(tokens, 2253); // what `etium status` reported for the live run
});

test("pi parser: failed tool executions surface; garbage lines are raw-only", () => {
  const fail = pi.parse!(
    JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "command not found" }] },
    }),
  );
  assert.match((fail?.[0] as { summary: string }).summary, /^error: command not found/);
  assert.equal(
    pi.parse!(JSON.stringify({ type: "tool_execution_end", toolName: "write", isError: false, result: {} })),
    null,
  );
  assert.equal(pi.parse!("not json"), null);
  assert.equal(pi.parse!(JSON.stringify({ type: "mystery" })), null);
});

test("replay through pi parser: full runner pass records activity and usage", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "etium-pi-replay-"));
  const runDir = path.join(base, "run");
  const stepDir = path.join(runDir, "steps", "001-t.0");
  const workspace = path.join(base, "ws");
  fs.mkdirSync(stepDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const activity: Array<{ kind: string; summary: string }> = [];
  const a: RunStepArgs = {
    runDir,
    stepDir,
    name: "t",
    occ: 0,
    opts: { harness: "replay", fixture: path.join(fixturesDir, "synthetic.jsonl"), inner: "pi" },
    prompt: "",
    workspace,
    emitActivity: (kind, summary) => activity.push({ kind, summary }),
    emitWarning: () => {},
  };
  const r = await runStep(a);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.usage, { tokensIn: 42, tokensOut: 12, costUsd: 0.0003 });
  assert.ok(activity.some((e) => e.kind === "message" && /hello world/.test(e.summary)));
  assert.ok(activity.some((e) => e.kind === "lifecycle"));
});

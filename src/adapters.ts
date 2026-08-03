// Harness adapters (§10). Core owns spawning, raw capture, redaction, budgets,
// and kill; an adapter is a command builder plus a pure line parser.

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type {
  AdapterBuildRequest,
  BuildResult,
  HarnessAdapter,
  HarnessEvent,
} from "./types.ts";

const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------------------------------------------------------------------------
// exec — any command as a black-box step. The interface floor (§10.2): only
// lifecycle events, unmetered, wall-clock budget only. Also the vehicle for
// publication steps under the `host` env profile (§9).
// ---------------------------------------------------------------------------
export const execAdapter: HarnessAdapter = {
  id: "exec",
  build(req: AdapterBuildRequest): BuildResult {
    const command = req.command ?? req.prompt;
    if (!command) throw new Error("exec harness needs `command` (or a prompt used as one)");
    return { cmd: "/bin/sh", args: ["-c", command] };
  },
  // no parse: stdout is raw-only
};

// ---------------------------------------------------------------------------
// codex — PROVISIONAL parser. Built against the documented shape of
// `codex exec --json` (JSONL events on stdout) but not yet validated against
// captured fixtures; scripts/capture-fixtures.sh produces those, after which
// this parser gets hardened and the PROVISIONAL marker is removed. Unknown
// lines return null and live in raw only — nothing is lost either way.
// ---------------------------------------------------------------------------
export const codexAdapter: HarnessAdapter = {
  id: "codex",
  auth: {
    env: ["OPENAI_API_KEY"],
    check: { cmd: "codex", args: ["login", "status"] }, // exit semantics provisional (§10.2)
    remedy: "codex login",
  },
  build(req: AdapterBuildRequest): BuildResult {
    const args = ["exec", "--json"];
    if (req.model) args.push("-m", req.model);
    args.push(req.prompt);
    return { cmd: "codex", args };
  },
  parse(line: string): HarnessEvent[] | null {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      return null;
    }
    const t = j.type as string | undefined;
    const item = (j.item ?? j) as Record<string, unknown>;
    const itemType = (item.item_type ?? item.type) as string | undefined;

    const text = (item.text ?? item.message ?? j.message) as string | undefined;
    if (
      (t === "item.completed" && (itemType === "agent_message" || itemType === "reasoning")) ||
      t === "agent_message" ||
      t === "message"
    ) {
      return text ? [{ kind: "message", role: "assistant", summary: clip(text) }] : null;
    }
    if (t === "item.completed" && (itemType === "command_execution" || itemType === "tool_call")) {
      const cmd = (item.command ?? item.name ?? "tool") as string;
      return [{ kind: "tool", name: itemType === "tool_call" ? String(item.name ?? "tool") : "shell", summary: clip(String(cmd)) }];
    }
    const usage = (j.usage ?? (t === "token_count" ? j : undefined)) as
      | Record<string, number>
      | undefined;
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      return [
        {
          kind: "usage",
          usage: { tokensIn: usage.input_tokens ?? 0, tokensOut: usage.output_tokens ?? 0 },
        },
      ];
    }
    if (t === "thread.started" || t === "session.created") return [{ kind: "lifecycle", state: "started" }];
    if (t === "turn.completed" || t === "thread.completed") return [{ kind: "lifecycle", state: "exiting" }];
    return null;
  },
};

// ---------------------------------------------------------------------------
// pi — parser validated against captured fixtures (fixtures/pi/, 2026-08-02,
// session stream v3): message, usage, error, lifecycle, and tool shapes all
// grounded in real streams (the tool-use capture was made by etium itself).
// Unknown lines (message_update deltas, turn_*, session) return null and
// live in raw only. Note: pi exits 0 even when the turn errors — the
// assistant message carries stopReason "error" + errorMessage, which we
// surface as a message event so failures are visible in `etium tail`.
// ---------------------------------------------------------------------------
export const piAdapter: HarnessAdapter = {
  id: "pi",
  auth: {
    // Credential vars pi documents (§10.2); declared values are always redacted.
    env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"],
    remedy: "pi, then /login",
  },
  build(req: AdapterBuildRequest): BuildResult {
    const args = ["-p", "--mode", "json"];
    if (req.model) args.push("--model", req.model); // supports "provider/id" patterns
    args.push(req.prompt);
    return { cmd: "pi", args };
  },
  parse(line: string): HarnessEvent[] | null {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line);
    } catch {
      return null;
    }
    const t = String(j.type ?? "");
    if (t === "agent_start") return [{ kind: "lifecycle", state: "started" }];
    if (t === "agent_end") return [{ kind: "lifecycle", state: "exiting" }];

    // Assistant content and usage both ride on message_end. message_start /
    // turn_end repeat the same message object; only message_end is counted.
    if (t === "message_end") {
      const m = (j.message ?? {}) as Record<string, unknown>;
      if (m.role !== "assistant") return null;
      const events: HarnessEvent[] = [];
      const parts = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
      const text = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join(" ");
      const summary =
        text || (typeof m.errorMessage === "string" ? `error: ${m.errorMessage}` : "");
      if (summary) events.push({ kind: "message", role: "assistant", summary: clip(summary) });
      const u = m.usage as Record<string, unknown> | undefined;
      if (u && (typeof u.input === "number" || typeof u.output === "number")) {
        const cost = (u.cost as Record<string, unknown> | undefined)?.total;
        events.push({
          kind: "usage",
          usage: {
            tokensIn: typeof u.input === "number" ? u.input : 0,
            tokensOut: typeof u.output === "number" ? u.output : 0,
            costUsd: typeof cost === "number" ? cost : undefined,
          },
        });
      }
      return events.length ? events : null;
    }

    if (t === "tool_execution_start") {
      const name = String(j.toolName ?? "tool");
      return [{ kind: "tool", name, summary: clip(j.args === undefined ? name : JSON.stringify(j.args)) }];
    }
    if (t === "tool_execution_end") {
      // Success results ride the following toolResult message; surface failures.
      if (j.isError !== true) return null;
      const parts = (j.result as { content?: { type?: string; text?: string }[] } | undefined)?.content;
      const text = Array.isArray(parts)
        ? parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ")
        : "";
      return [{ kind: "tool", name: String(j.toolName ?? "tool"), summary: clip(`error: ${text || "tool failed"}`) }];
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// replay — plays a recorded raw stream through another adapter's parser.
// Deterministic, token-free end-to-end runs; what the test suite runs on.
// ---------------------------------------------------------------------------
const REPLAY_SCRIPT = `
const fs = require("node:fs");
const [file, delayMs] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean);
const d = Number(delayMs) || 0;
(async () => {
  for (const l of lines) {
    process.stdout.write(l + "\\n");
    if (d) await new Promise((r) => setTimeout(r, d));
  }
})();
`;

export const replayAdapter: HarnessAdapter = {
  id: "replay",
  build(req: AdapterBuildRequest): BuildResult {
    if (!req.fixture) throw new Error("replay harness needs `fixture`");
    const fixture = path.isAbsolute(req.fixture)
      ? req.fixture
      : path.resolve(req.workspace, req.fixture);
    return { cmd: process.execPath, args: ["-e", REPLAY_SCRIPT, fixture, "0"] };
  },
  // parse is resolved dynamically to the inner adapter's parser (see resolve()).
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const registry = new Map<string, HarnessAdapter>(
  [execAdapter, codexAdapter, piAdapter, replayAdapter].map((a) => [a.id, a]),
);

export function allAdapters(): HarnessAdapter[] {
  return [...registry.values()];
}

export function getAdapter(id: string): HarnessAdapter {
  const a = registry.get(id);
  if (!a) throw new Error(`unknown harness: ${id} (available: ${[...registry.keys()].join(", ")})`);
  return a;
}

/** Resolve the adapter and the parser to apply to its stdout. For `replay`,
 * the parser comes from the inner adapter being replayed. */
export function resolve(
  harness: string,
  inner?: string,
): { adapter: HarnessAdapter; parse?: (line: string) => HarnessEvent[] | null } {
  const adapter = getAdapter(harness);
  if (harness === "replay") {
    const innerAdapter = getAdapter(inner ?? "codex");
    return { adapter, parse: innerAdapter.parse?.bind(innerAdapter) };
  }
  return { adapter, parse: adapter.parse?.bind(adapter) };
}

export function bundledLoopsDir(): string {
  // dist/adapters.js -> ../loops ; src/adapters.ts -> ../loops
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "loops");
}

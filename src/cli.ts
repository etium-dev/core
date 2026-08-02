#!/usr/bin/env node
// The etium CLI (§8). Files in, files out; every command is a thin verb over
// the ledger, the lock, and the mailbox.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LedgerWriter, loadState, openGates, readLedger, writeStateCache } from "./ledger.ts";
import { isLockLive, readLock, writeDecision } from "./lock.ts";
import { createRun, supervise, superviseDetached } from "./supervisor.ts";
import { loadSurfaces, tickOnce } from "./tick.ts";
import { DEFAULT_GATE_OPTIONS, ETIUM_VERSION, type AnyEnvelope } from "./types.ts";

const HELP = `etium — the outer loop for coding agents

usage:
  etium run [goal…] [--task file] [--loop name|path] [--harness h]
            [--param k=v]… [--approve gate]… [--sync]
            [--workspace dir | --worktree [--base ref]]   (--worktree: own branch etium/<run-id> off ref|HEAD of the repo at cwd)
  etium status [run]         one line per run, or detail for one
  etium gates                open gates across all runs
  etium approve <run> <gate> [--note text]
  etium decide  <run> <gate> <option> [--note text]   (gates with declared options)
  etium reject  <run> <gate> [--note text]
  etium resume  <run>        attach a supervisor
  etium abandon <run> [--reason text]
  etium tail    <run> [--once]
  etium tick [--surface path]…   reconcile all runs; poll/project surfaces (cron-safe, idempotent)
  etium fold    <run>        rebuild state.json from the ledger
  etium --version

Base directory: --dir, else $ETIUM_DIR, else ./.etium
`;

const entry = fileURLToPath(import.meta.url);

function base(dir?: string): string {
  return path.resolve(dir ?? process.env.ETIUM_DIR ?? ".etium");
}
function runsDir(b: string): string {
  return path.join(b, "runs");
}
function wantSync(flag?: boolean): boolean {
  return Boolean(flag) || process.env.ETIUM_SYNC === "1";
}

function resolveRunDir(b: string, idOrPrefix: string): string {
  const dir = runsDir(b);
  const exact = path.join(dir, idOrPrefix);
  if (fs.existsSync(exact)) return exact;
  const all = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const hits = all.filter((n) => n.includes(idOrPrefix));
  if (hits.length === 1) return path.join(dir, hits[0]!);
  throw new Error(
    hits.length === 0 ? `no run matching "${idOrPrefix}"` : `ambiguous run "${idOrPrefix}": ${hits.join(", ")}`,
  );
}

function age(ts?: string): string {
  if (!ts) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtEvent(e: AnyEnvelope): string {
  const t = e.ts.slice(11, 19);
  switch (e.type) {
    case "run.created":
      return `${t}  run created      loop=${path.basename(e.data.loop)} workspace=${e.data.workspace}`;
    case "supervisor.started":
      return `${t}  supervisor       pid=${e.data.pid}@${e.data.host}`;
    case "step.started":
      return `${t}  step ▶ ${e.data.name}.${e.data.occ}  [${e.data.harness}]${e.data.notes ? ` notes=${e.data.notes}` : ""}`;
    case "step.activity":
      return `${t}    · ${e.data.kind.padEnd(9)} ${e.data.summary}`;
    case "step.completed": {
      const d = e.data;
      const mark = d.status === "ok" && d.passed !== false ? "✓" : "✗";
      const tok = d.usage ? `  ${(d.usage.tokensIn ?? 0) + (d.usage.tokensOut ?? 0)} tok` : "";
      return `${t}  step ${mark} ${d.step.name}.${d.step.occ}  ${d.status}${d.passed !== undefined ? ` passed=${d.passed}` : ""}${tok}`;
    }
    case "gate.opened": {
      const opts = e.data.options ?? DEFAULT_GATE_OPTIONS;
      const binary = opts.length === 2 && opts.includes("approve") && opts.includes("reject");
      return `${t}  gate ? ${e.data.name}.${e.data.occ}  awaiting decision${binary ? "" : `  options=${opts.join("|")}`}${e.data.show.length ? `  show=${e.data.show.join(",")}` : ""}`;
    }
    case "gate.decided": {
      const mark = e.data.decision === "approve" ? "✓" : e.data.decision === "reject" ? "✗" : "◆";
      return `${t}  gate ${mark} ${e.data.name}.${e.data.occ}  ${e.data.decision} by ${e.data.by} (${e.data.via})${e.data.note ? ` — ${e.data.note}` : ""}`;
    }
    case "effect.recorded":
      return `${t}  effect ${e.data.name}.${e.data.occ}`;
    case "budget.warning":
      return `${t}  ⚠ ${e.data.kind}: ${e.data.detail}`;
    case "budget.exceeded":
      return `${t}  ⛔ budget ${e.data.budget} exceeded → ${e.data.action} (${e.data.step.name}.${e.data.step.occ})`;
    case "run.parked":
      return `${t}  run parked       gates: ${e.data.gates.map((g) => `${g.name}.${g.occ}`).join(", ")}`;
    case "run.interrupted":
      return `${t}  run interrupted  (${e.data.reason})`;
    case "run.completed":
      return `${t}  run ${e.data.status.toUpperCase()}${e.data.summary ? `  ${e.data.summary}` : ""}${e.data.orphans ? `  orphans=${e.data.orphans.length}` : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRun(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: {
      loop: { type: "string", default: "ralph" },
      task: { type: "string" },
      harness: { type: "string" },
      param: { type: "string", multiple: true },
      approve: { type: "string", multiple: true },
      workspace: { type: "string" },
      worktree: { type: "boolean" },
      base: { type: "string" },
      dir: { type: "string" },
      sync: { type: "boolean" },
      "max-steps": { type: "string" },
    },
    allowPositionals: true,
  });
  const b = base(v.dir);
  const goal = positionals.join(" ").trim();
  const taskText = v.task ? fs.readFileSync(v.task, "utf8") : goal;
  if (!taskText) {
    process.stderr.write("etium run: provide a goal or --task file\n");
    return 2;
  }
  const params: Record<string, string> = {};
  for (const p of v.param ?? []) {
    const i = p.indexOf("=");
    if (i === -1) {
      process.stderr.write(`etium run: --param expects k=v, got "${p}"\n`);
      return 2;
    }
    params[p.slice(0, i)] = p.slice(i + 1);
  }
  if (v.harness) params.harness = v.harness;

  let created: { runId: string; runDir: string };
  try {
    created = createRun(b, {
      task: taskText,
      loop: v.loop!,
      params,
      workspace: v.workspace,
      worktree: v.worktree ? { repo: process.cwd(), base: v.base } : undefined,
      preapprove: v.approve ?? [],
      maxSteps: v["max-steps"] ? Number(v["max-steps"]) : undefined,
      idSeed: v.task ? path.basename(v.task, path.extname(v.task)) : goal,
    });
  } catch (e) {
    process.stderr.write(`etium run: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  process.stdout.write(`${created.runId}\n`);
  if (wantSync(v.sync)) {
    const outcome = await supervise(created.runDir);
    process.stdout.write(`outcome: ${outcome}\n`);
    return outcome === "error" ? 1 : 0;
  }
  superviseDetached(created.runDir, entry);
  process.stdout.write(`supervisor detached; \`etium status ${created.runId}\` to watch\n`);
  return 0;
}

function cmdStatus(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
    allowPositionals: true,
  });
  const b = base(v.dir);
  if (positionals[0]) {
    const runDir = resolveRunDir(b, positionals[0]);
    const st = loadState(runDir);
    writeStateCache(runDir, st);
    const lock = readLock(runDir);
    process.stdout.write(`run:     ${st.run}\n`);
    process.stdout.write(`status:  ${st.status}${isLockLive(runDir, lock) ? ` (supervisor pid ${lock!.pid})` : ""}\n`);
    process.stdout.write(`usage:   ${st.usage.tokensIn + st.usage.tokensOut} tokens  $${st.usage.costUsd.toFixed(4)}\n`);
    const og = openGates(st);
    if (og.length)
      process.stdout.write(`gates:   ${og.map((g) => `${g.name}.${g.occ}`).join(", ")}  → etium approve ${st.run} <gate>\n`);
    process.stdout.write(`\nrecent events:\n`);
    for (const e of readLedger(runDir).slice(-12)) process.stdout.write(`  ${fmtEvent(e)}\n`);
    return 0;
  }
  const dir = runsDir(b);
  const rows: string[][] = [["RUN", "STATUS", "GATES", "TOKENS", "AGE"]];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const runDir = path.join(dir, name);
    if (!fs.statSync(runDir).isDirectory()) continue;
    const st = loadState(runDir);
    const live = isLockLive(runDir, readLock(runDir));
    rows.push([
      name,
      st.status === "running" && !live ? "running (orphaned — run `etium tick`)" : st.status,
      String(openGates(st).length || ""),
      String(st.usage.tokensIn + st.usage.tokensOut || ""),
      age(st.lastEventTs),
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows)
    process.stdout.write(r.map((c, i) => c.padEnd(widths[i]! + 2)).join("") + "\n");
  return 0;
}

function cmdGates(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, options: { dir: { type: "string" } } });
  const dir = runsDir(base(v.dir));
  let any = false;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const runDir = path.join(dir, name);
    if (!fs.statSync(runDir).isDirectory()) continue;
    const st = loadState(runDir);
    for (const g of openGates(st)) {
      any = true;
      const declared = g.opened!.options ?? DEFAULT_GATE_OPTIONS;
      const binary = declared.length === 2 && declared.includes("approve") && declared.includes("reject");
      const hint = binary
        ? `  → etium approve ${name} ${g.name}   |   etium reject ${name} ${g.name}\n`
        : `  → etium decide ${name} ${g.name} <${declared.join("|")}>\n`;
      process.stdout.write(
        `${name}  ${g.name}.${g.occ}${g.opened!.show.length ? `  show: ${g.opened!.show.join(", ")}` : ""}\n` + hint,
      );
    }
  }
  if (!any) process.stdout.write("no open gates\n");
  return 0;
}

/** `fixed` is set for the approve/reject sugar verbs; `etium decide` reads the
 * option from the third positional. */
async function decide(argv: string[], fixed?: "approve" | "reject"): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { note: { type: "string" }, dir: { type: "string" }, sync: { type: "boolean" } },
    allowPositionals: true,
  });
  const [runRef, gateName] = positionals;
  const decision = fixed ?? positionals[2];
  const verb = fixed ?? "decide";
  if (!runRef || !gateName || !decision) {
    process.stderr.write(
      fixed
        ? `usage: etium ${verb} <run> <gate> [--note text]\n`
        : `usage: etium decide <run> <gate> <option> [--note text]\n`,
    );
    return 2;
  }
  const runDir = resolveRunDir(base(v.dir), runRef);
  const st = loadState(runDir);
  const open = openGates(st)
    .filter((g) => g.name === gateName)
    .sort((a, b) => a.occ - b.occ);
  if (open.length === 0) {
    // Fail closed (§8): no blind decisions for gates that are not open.
    process.stderr.write(
      `etium ${verb}: gate "${gateName}" is not open on ${st.run}. Open gates: ${
        openGates(st).map((g) => g.name).join(", ") || "none"
      }\n`,
    );
    return 1;
  }
  const g = open[0]!;
  // Fail closed (§8): the ledger's declared option set is the authority.
  const declared = g.opened!.options ?? DEFAULT_GATE_OPTIONS;
  if (!declared.includes(decision)) {
    process.stderr.write(
      `etium ${verb}: "${decision}" is not a declared option for gate "${gateName}" (options: ${declared.join(", ")})\n`,
    );
    return 1;
  }
  writeDecision(runDir, {
    name: g.name,
    occ: g.occ,
    decision,
    note: v.note,
    by: os.userInfo().username,
    via: "cli",
    ts: new Date().toISOString(),
  });
  if (isLockLive(runDir, readLock(runDir))) {
    process.stdout.write(`decision queued; the live supervisor will pick it up\n`);
    return 0;
  }
  if (wantSync(v.sync)) {
    const outcome = await supervise(runDir);
    process.stdout.write(`outcome: ${outcome}\n`);
    return outcome === "error" ? 1 : 0;
  }
  superviseDetached(runDir, entry);
  process.stdout.write(`decision written; supervisor attached\n`);
  return 0;
}

async function cmdResume(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string" }, sync: { type: "boolean" } },
    allowPositionals: true,
  });
  if (!positionals[0]) {
    process.stderr.write("usage: etium resume <run>\n");
    return 2;
  }
  const runDir = resolveRunDir(base(v.dir), positionals[0]);
  if (wantSync(v.sync)) {
    const outcome = await supervise(runDir);
    process.stdout.write(`outcome: ${outcome}\n`);
    return outcome === "error" ? 1 : 0;
  }
  superviseDetached(runDir, entry);
  process.stdout.write("supervisor attached\n");
  return 0;
}

async function cmdAbandon(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { reason: { type: "string" }, dir: { type: "string" } },
    allowPositionals: true,
  });
  if (!positionals[0]) {
    process.stderr.write("usage: etium abandon <run> [--reason text]\n");
    return 2;
  }
  const runDir = resolveRunDir(base(v.dir), positionals[0]);
  const lock = readLock(runDir);
  if (isLockLive(runDir, lock)) {
    try {
      process.kill(lock!.pid, "SIGTERM");
    } catch {
      /* raced */
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isLockLive(runDir, readLock(runDir)))
      await new Promise((r) => setTimeout(r, 100));
    if (isLockLive(runDir, readLock(runDir))) {
      try {
        process.kill(lock!.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        fs.unlinkSync(path.join(runDir, "lock"));
      } catch {
        /* gone */
      }
    }
  }
  const st = loadState(runDir);
  // Errored runs stay resumable (§6.3) and therefore also abandonable.
  if (st.completed && st.completed.status !== "error") {
    process.stdout.write(`run already completed (${st.completed.status})\n`);
    return 0;
  }
  const w = new LedgerWriter(runDir, st.run, st.seq);
  w.append("run.completed", { status: "abandoned", summary: v.reason });
  w.close();
  writeStateCache(runDir, loadState(runDir));
  process.stdout.write(`abandoned ${st.run}\n`);
  return 0;
}

async function cmdTail(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string" }, once: { type: "boolean" } },
    allowPositionals: true,
  });
  if (!positionals[0]) {
    process.stderr.write("usage: etium tail <run> [--once]\n");
    return 2;
  }
  const runDir = resolveRunDir(base(v.dir), positionals[0]);
  let seen = 0;
  for (;;) {
    const events = readLedger(runDir);
    for (const e of events.slice(seen)) process.stdout.write(fmtEvent(e) + "\n");
    seen = events.length;
    if (v.once) return 0;
    const last = events.at(-1);
    if (last?.type === "run.completed") return 0;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function cmdTick(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      sync: { type: "boolean" },
      surface: { type: "string", multiple: true },
    },
  });
  const surfaces = await loadSurfaces(v.surface ?? []);
  const actions = await tickOnce(base(v.dir), entry, wantSync(v.sync), surfaces);
  for (const a of actions)
    process.stdout.write(`${a.run.padEnd(36)} ${a.action}${a.detail ? `  (${a.detail})` : ""}\n`);
  if (!actions.length) process.stdout.write("no runs\n");
  return 0;
}

function cmdFold(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
    allowPositionals: true,
  });
  if (!positionals[0]) {
    process.stderr.write("usage: etium fold <run>\n");
    return 2;
  }
  const runDir = resolveRunDir(base(v.dir), positionals[0]);
  const st = loadState(runDir);
  writeStateCache(runDir, st);
  process.stdout.write(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "run":
        return await cmdRun(rest);
      case "status":
        return cmdStatus(rest);
      case "gates":
        return cmdGates(rest);
      case "approve":
        return await decide(rest, "approve");
      case "reject":
        return await decide(rest, "reject");
      case "decide":
        return await decide(rest);
      case "resume":
        return await cmdResume(rest);
      case "abandon":
        return await cmdAbandon(rest);
      case "tail":
        return await cmdTail(rest);
      case "tick":
        return await cmdTick(rest);
      case "fold":
        return cmdFold(rest);
      case "_supervise": {
        const outcome = await supervise(path.resolve(rest[0]!));
        process.stdout.write(`outcome: ${outcome}\n`);
        return outcome === "error" ? 1 : 0;
      }
      case "--version":
      case "version":
        process.stdout.write(ETIUM_VERSION + "\n");
        return 0;
      default:
        process.stdout.write(HELP);
        return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
    }
  } catch (e) {
    process.stderr.write(`etium: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

const invoked = process.argv[1]
  ? (() => {
      try {
        return fs.realpathSync(process.argv[1]!); // npm bins are symlinks
      } catch {
        return path.resolve(process.argv[1]!);
      }
    })()
  : "";
if (invoked === entry) {
  // `etium status | head` must not crash: a closed pipe ends output, not the run.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

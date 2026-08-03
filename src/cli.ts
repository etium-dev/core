#!/usr/bin/env node
// The etium CLI (§8). Files in, files out; every command is a thin verb over
// the ledger, the lock, and the mailbox.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { allAdapters } from "./adapters.ts";
import { checkHarnessAuth } from "./runner.ts";
import { loadState, openGates, readLedger, writeStateCache } from "./ledger.ts";
import { isLockLive, readLock, writeDecision } from "./lock.ts";
import { abandonRun, createRun, supervise, superviseDetached } from "./supervisor.ts";
import { loadSurfaces, tickOnce, watchLoop } from "./tick.ts";
import { DEFAULT_GATE_OPTIONS, ETIUM_VERSION, type AnyEnvelope } from "./types.ts";

const HELP = `etium — the outer loop for coding agents

usage:
  etium run [goal…] [--task file] [--loop path] [--harness h]
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
  etium tick [--surface name|path]…   reconcile all runs; poll/project surfaces (cron-safe, idempotent)
  etium watch [--surface name|path]… [--every seconds]   tick on an interval, foreground (Ctrl-C to stop)
  etium rebuild <run>        rebuild state.json from the ledger
  etium clone-loop [library] [--into dir]   copy a loop library (ralph, ai-engineer) into your repo (no arg: list)
  etium init [--library ralph|ai-engineer|none] [--github owner/name|off] [--trusted logins]
             [--act-as login|me] [--wakeup watch|cron|print] [--git-name n] [--git-email e] [--yes]
             check dependencies (with fix commands), ask the setup questions, apply
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
      loop: { type: "string" },
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
      loop: v.loop ?? "ralph/loop.ts",
      params,
      workspace: v.workspace,
      worktree: v.worktree ? { repo: process.cwd(), base: v.base } : undefined,
      preapprove: v.approve ?? [],
      maxSteps: v["max-steps"] ? Number(v["max-steps"]) : undefined,
      idSeed: v.task ? path.basename(v.task, path.extname(v.task)) : goal,
    });
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    if (!v.loop && msg.startsWith("loop not found"))
      msg += `\n  (no --loop given; the default is ralph/loop.ts — put the reference loop there:\n   etium clone-loop ralph)`;
    process.stderr.write(`etium run: ${msg}\n`);
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
  const result = await abandonRun(runDir, v.reason);
  process.stdout.write(
    result === "already-completed"
      ? `run already completed\n`
      : `abandoned ${path.basename(runDir)}\n`,
  );
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

/** Loop libraries bundled in the package: copy-and-own content (`etium
 * clone-loop <name>`). A cloned library is the user's to edit; upgrades are
 * a fresh clone into a scratch dir and a diff, never an auto-merge. */
const LIBRARIES = ["ralph", "ai-engineer"];

function cmdCloneLoop(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { into: { type: "string" } },
    allowPositionals: true,
  });
  const packageRoot = path.resolve(path.dirname(entry), "..");
  const name = positionals[0];
  if (!name) {
    process.stdout.write(`bundled loop libraries:\n`);
    for (const l of LIBRARIES) process.stdout.write(`  ${l}    → etium clone-loop ${l}\n`);
    return 0;
  }
  if (!LIBRARIES.includes(name)) {
    process.stderr.write(`etium clone-loop: unknown library "${name}" (available: ${LIBRARIES.join(", ")})\n`);
    return 2;
  }
  const src = path.join(packageRoot, name);
  const dest = path.resolve(v.into ?? name);
  if (fs.existsSync(dest)) {
    process.stderr.write(`etium clone-loop: ${dest} already exists — clone-loop never overwrites. Clone into a scratch dir (--into) and diff to upgrade.\n`);
    return 1;
  }
  fs.cpSync(src, dest, { recursive: true });
  // Runs write .etium/ next to where you work; keep it out of the repo.
  const gi = path.join(path.dirname(dest), ".gitignore");
  const has = fs.existsSync(gi) && fs.readFileSync(gi, "utf8").split("\n").includes(".etium/");
  if (!has) fs.appendFileSync(gi, `${fs.existsSync(gi) && !fs.readFileSync(gi, "utf8").endsWith("\n") ? "\n" : ""}.etium/\n`);
  const rel = path.relative(process.cwd(), dest) || ".";
  const guide = fs.existsSync(path.join(dest, "TUTORIAL.md")) ? "TUTORIAL.md" : "README.md";
  process.stdout.write(`cloned ${name} → ${rel}/ (yours to edit) — see ${rel}/${guide}\n`);
  return 0;
}


// ---------------------------------------------------------------------------
// etium init (§9, ADR-014): checks → questions → apply, in the installer's
// look and feel: the ring logo, a sentence of why before every check, and
// questions as explained numbered menus. Flags answer everything for
// agents; nothing prompts without a TTY.
// ---------------------------------------------------------------------------

const sh = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });

const TTY = () => process.stdout.isTTY === true;
const style = (code: string, t: string) => (TTY() ? `\x1b[${code}m${t}\x1b[0m` : t);

const RING_LEN = 28;
function ringIndex(y: number, x: number): number {
  if (y === 0) return x;
  if (x === 10 && y < 4) return 10 + y;
  if (y === 4) return 14 + 10 - x;
  if (x === 0 && y > 0) return 28 - y;
  return -1;
}

function ringFrame(head: number, settled: boolean): string {
  const esc = "\x1b[";
  const rows: string[] = [];
  for (let y = 0; y < 5; y++) {
    let row = "  ";
    for (let x = 0; x <= 10; x++) {
      const idx = ringIndex(y, x);
      if (idx >= 0) {
        let color = "36";
        if (!settled) {
          const d = (head - idx + RING_LEN) % RING_LEN;
          color = d === 0 ? "1;96" : d <= 2 ? "36" : d <= 5 ? "2;36" : "90";
        }
        row += `${esc}${color}m██${esc}0m`;
      } else if (y === 2 && x === 1) {
        row += `${esc}1m     E T I U M    ${esc}0m`;
        x = 9;
      } else {
        row += "  ";
      }
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** One lap of the runner around the outer loop, drawn in place (no screen
 * clear — init shares the user's scrollback). Static ring when not a TTY. */
async function ringAnimation(): Promise<void> {
  const o = (t: string) => process.stdout.write(t);
  o("\n");
  if (!TTY() && process.env.ETIUM_LOGO_FORCE !== "1") {
    o(ringFrame(0, true).replace(/\x1b\[[0-9;]*m/g, "") + "\n");
    return;
  }
  const restore = () => o("\x1b[?25h");
  process.once("SIGINT", restore);
  o("\x1b[?25l");
  o(ringFrame(0, false) + "\n");
  for (let s = 1; s <= RING_LEN; s++) {
    await new Promise((r) => setTimeout(r, 30));
    o(`\x1b[5A\r${ringFrame(s % RING_LEN, false)}\n`);
  }
  await new Promise((r) => setTimeout(r, 30));
  o(`\x1b[5A\r${ringFrame(0, true)}\n`);
  restore();
  process.removeListener("SIGINT", restore);
}

async function initBanner(): Promise<void> {
  const o = (t: string) => process.stdout.write(t + "\n");
  await ringAnimation();
  o("");
  o(`  ${style("1", "Etium Setup")}`);
  o(`  ${style("2", "The outer loop for coding agents")}`);
  o("");
}

async function cmdInit(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      library: { type: "string" },
      github: { type: "string" },
      trusted: { type: "string" },
      "act-as": { type: "string" },
      wakeup: { type: "string" },
      "git-name": { type: "string" },
      "git-email": { type: "string" },
      yes: { type: "boolean" },
      dir: { type: "string" },
    },
  });
  const out = (t = "") => process.stdout.write(t + "\n");
  const interactive = process.stdin.isTTY && !v.yes;

  await initBanner();
  out("Etium supervises coding agents working in this repository. Every run");
  out("is recorded as plain files, and each run can work on its own git");
  out("branch. Setup checks this machine, asks a few questions, and applies");
  out("your answers — nothing here needs sudo.");
  out();
  out(style("1", "Checking this machine"));
  out();

  let hardFail = false;
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = (maj === 22 && min! >= 18) || (maj === 23 && min! >= 6) || maj! >= 24;
  if (nodeOk) out(`  ok     node ${process.versions.node}`);
  else {
    out(`  needs  node ≥ 22.18 (you have ${process.versions.node}) — etium runs your`);
    out(`         TypeScript loops natively, which needs it — run: nvm install --lts`);
    hardFail = true;
  }
  out(`  ok     etium ${ETIUM_VERSION}`);
  const etiums = (() => {
    const seen = new Map<string, string>(); // realpath -> first PATH entry serving it
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, "etium");
      try {
        fs.accessSync(p, fs.constants.X_OK);
        const real = fs.realpathSync(p);
        if (!seen.has(real)) seen.set(real, p);
      } catch {
        /* not in this dir */
      }
    }
    return [...seen.values()];
  })();
  if (etiums.length > 1) {
    const [active, ...shadowed] = etiums;
    out(`  needs  one etium install — this machine has ${etiums.length}; PATH serves the first:`);
    out(`         ${active}   (this one runs)`);
    for (const s of shadowed) {
      const prefix = path.dirname(path.dirname(s));
      const sudo = prefix.startsWith(os.homedir() + path.sep) ? "" : "sudo ";
      out(`         ${s}   (shadowed — updates here never take effect)`);
      out(`         remove it: ${sudo}npm uninstall -g --prefix ${prefix} @etium/core`);
    }
    hardFail = true;
  }
  if (sh("git", ["--version"]).status === 0) {
    out("  ok     git — each run can work on its own isolated branch");
  } else {
    out("  needs  git — etium gives every run its own branch, so git is required");
    out("         run: xcode-select --install   (macOS; else https://git-scm.com)");
    hardFail = true;
  }
  const top = sh("git", ["rev-parse", "--show-toplevel"]);
  const repoDir = top.status === 0 ? (top.stdout || "").trim() : undefined;
  if (repoDir) out(`  ok     repository: ${repoDir} — runs are recorded here, under .etium/`);
  else {
    out("  needs  a repository — etium works inside the repository it supervises;");
    out("         cd into one, then run: etium init");
    hardFail = true;
  }
  const gitIdentOk = sh("git", ["config", "user.email"]).status === 0;
  if (gitIdentOk) out("  ok     git identity — run commits have an author");
  else if (interactive || (v["git-name"] && v["git-email"])) out("  note   git identity not set — configured below");
  else {
    out("  needs  a git identity — runs commit their work, and git refuses commits");
    out("         without an author. Run etium init in a terminal to be prompted,");
    out(`         or pass: --git-name "Your Name" --git-email you@example.com`);
    hardFail = true;
  }
  const ghInstalled = sh("gh", ["--version"]).status === 0;
  const ghAuthed = ghInstalled && sh("gh", ["auth", "status"]).status === 0;
  const ghLogin = ghAuthed ? (sh("gh", ["api", "user", "--jq", ".login"]).stdout || "").trim() : "";
  if (ghInstalled && ghAuthed) out(`  ok     gh — signed in as ${ghLogin || "unknown"} (only needed for GitHub wiring)`);
  else if (ghInstalled) out("  note   gh installed but not signed in — fine unless GitHub should drive");
  else out("  note   gh (GitHub CLI) not installed — fine unless GitHub should drive");
  if (!ghAuthed) out("         the engineer; then: curl -sS https://webi.sh/gh | sh, and: gh auth login");

  let anyHarness = false;
  for (const ad of allAdapters()) {
    if (ad.id === "exec" || ad.id === "replay") continue;
    if (sh(ad.id, ["--version"]).status !== 0) continue;
    anyHarness = true;
    if (!ad.auth?.check) {
      out(`  ok     harness ${ad.id} — installed (it manages its own sign-in: ${ad.auth?.remedy ?? "see its docs"})`);
    } else if (checkHarnessAuth(ad.id).ok) {
      out(`  ok     harness ${ad.id} — installed and signed in`);
    } else {
      out(`  needs  harness ${ad.id} sign-in — run: ${ad.auth?.remedy ?? "see its docs"}`);
    }
  }
  if (!anyHarness) {
    out("  needs  a coding-agent harness — harnesses are the agents etium");
    out("         supervises; install at least one, then run etium init again:");
    out("         pi     https://pi.dev");
    out("         codex  https://github.com/openai/codex");
    hardFail = true;
  }
  out();
  if (hardFail) {
    out("Fix the `needs` lines above, then run: etium init");
    return 1;
  }

  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;

  const menu = async (
    title: string,
    explain: string[],
    options: { label: string; value: string }[],
    defIdx: number,
    flagVal?: string,
  ): Promise<string> => {
    if (flagVal !== undefined) return flagVal;
    if (!rl) return options[defIdx]!.value;
    out();
    out(style("1", title));
    out();
    for (const line of explain) out(`  ${line}`);
    out();
    options.forEach((o, i) => out(`  ${i + 1}    ${o.label}${i === defIdx ? "  (default)" : ""}`));
    out();
    for (;;) {
      const a = (await rl.question(`Choose [${defIdx + 1}]: `)).trim().toLowerCase();
      if (!a) return options[defIdx]!.value;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
      const hit = options.find((o) => o.value === a || o.label.toLowerCase().startsWith(a));
      if (hit) return hit.value;
      out(`  Please answer 1–${options.length}.`);
    }
  };
  const askText = async (title: string, explain: string[], def: string, flagVal?: string): Promise<string> => {
    if (flagVal !== undefined) return flagVal;
    if (!rl) return def;
    out();
    out(style("1", title));
    out();
    for (const line of explain) out(`  ${line}`);
    out();
    const a = (await rl.question(def ? `${title} [${def}]: ` : `${title}: `)).trim();
    return a || def;
  };

  try {
    if (!gitIdentOk) {
      const name = await askText(
        "Name for commits",
        ["Runs commit their work into git, and git requires an author.", "Set once for this machine (git config --global)."],
        process.env.USER ?? "",
        v["git-name"],
      );
      const email = await askText(
        "Email for commits",
        [],
        ghLogin ? `${ghLogin}@users.noreply.github.com` : "",
        v["git-email"],
      );
      if (!name || !email) {
        out("Both name and email are needed — run: etium init");
        return 1;
      }
      sh("git", ["config", "--global", "user.name", name]);
      sh("git", ["config", "--global", "user.email", email]);
      out();
      out(`  Git identity set: ${name} <${email}>`);
    }
    const library = await menu(
      "Loops",
      [
        "Etium runs \"loops\": programs that sequence agent steps and human",
        "approval gates. Two ship with etium; your pick is cloned into this",
        "repo as a folder you own. Any run can use any loop — this choice",
        "just sets up your starting point.",
      ],
      [
        { label: "ralph — one agent iterating until your check passes", value: "ralph" },
        { label: "ai-engineer — the multi-persona engineering workflow", value: "ai-engineer" },
        { label: "none — you'll write your own", value: "none" },
      ],
      0,
      v.library,
    );

    const originUrl = (sh("git", ["remote", "get-url", "origin"]).stdout || "").trim();
    const originRepo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(originUrl)?.[1] ?? "";
    let github =
      v.github ??
      (await menu(
        "GitHub wiring",
        [
          "With GitHub wiring, assigning an issue to the engineer starts a run,",
          "and /et comments on the issue drive it. Without it, you drive runs",
          "from this terminal — you can always wire GitHub up later.",
        ],
        [
          { label: "Terminal only", value: "off" },
          { label: "Wire up GitHub", value: "github" },
        ],
        0,
      ));

    let trusted = v.trusted ?? "";
    let actAs = v["act-as"] ?? "me";
    let wakeup = v.wakeup ?? "watch";
    if (github !== "off") {
      if (!ghInstalled || !ghAuthed) {
        out();
        out("GitHub wiring needs the GitHub CLI (gh), installed and signed in:");
        out();
        if (!ghInstalled) out("  curl -sS https://webi.sh/gh | sh   (else https://cli.github.com)");
        out("  gh auth login                      (as the bot account, if the engineer acts as one)");
        out();
        out("Then run: etium init");
        return 1;
      }
      if (github === "github")
        github = await askText(
          "GitHub repository",
          ["The issues of this repository will drive the engineer (owner/name)."],
          originRepo,
        );
      trusted = await askText(
        "Your GitHub username",
        [
          "The engineer only obeys comments and assignments from usernames on",
          "this list. Start with just yourself; comma-separate to add teammates.",
        ],
        ghLogin || "your-login",
        v.trusted,
      );
      actAs = await menu(
        "The engineer acts as",
        [
          "Acting as you is the simple start: assigning yourself to an issue",
          "kicks it off. A separate bot account keeps the engineer's activity",
          "under its own name — this machine's gh must then be signed in as",
          "that bot, since it is who the engineer pushes and comments as.",
        ],
        [
          { label: "You", value: "me" },
          { label: "A separate bot account", value: "bot" },
        ],
        0,
        v["act-as"],
      );
      if (actAs === "bot") actAs = await askText("Bot username", ["The bot account's GitHub username."], "");
      wakeup = await menu(
        "Wake-up",
        ["The engineer wakes on a schedule to look for new work."],
        [
          { label: "etium watch — run it in a terminal while trying things out; nothing installed", value: "watch" },
          { label: "cron — install a once-a-minute crontab entry now (always-on)", value: "cron" },
          { label: "print — show the cron line; you install it yourself later", value: "print" },
        ],
        0,
        v.wakeup,
      );
    }
    rl?.close();

    out();
    if (library !== "none") {
      if (fs.existsSync(path.resolve(library))) out(`${library}/ is already in this repo — leaving it untouched.`);
      else {
        const r = await main(["clone-loop", library]);
        if (r !== 0) return r;
      }
    }
    if (github === "off") {
      out(style("1", "Done. Next:"));
      out();
      if (library === "ralph") {
        out(`  echo "your goal, precisely stated" > PROMPT.md`);
        out(`  etium run "your goal" --loop ralph/loop.ts --workspace . --param check="npm test"`);
        out();
        out(`  ralph iterates the agent until the check passes; swap in any check.`);
      } else if (library === "none") {
        out(`  write a loop (https://etium.dev/quickstart.html) and: etium run "goal" --loop your-loop.ts`);
      } else {
        out(`  etium run "your goal" --loop ${library}/loop.ts --worktree`);
      }
      return 0;
    }
    const agentLogin = actAs === "me" ? ghLogin : actAs;
    const env = `ETIUM_GH_REPO=${github} ETIUM_GH_TRUSTED=${trusted} ETIUM_GH_AGENT=${agentLogin} ETIUM_GH_LOOP=${library === "none" ? "<path-to-your-loop>" : `${library}/loop.ts`}`;
    const cronLine = `* * * * * cd ${repoDir} && ${env} etium tick --surface github >> .etium/tick.log 2>&1`;
    if (wakeup === "cron") {
      const cur = sh("crontab", ["-l"]);
      const kept = (cur.status === 0 ? cur.stdout : "").split("\n").filter((l) => l && !l.includes("etium tick --surface github"));
      const w = spawnSync("crontab", ["-"], { input: [...kept, cronLine, ""].join("\n"), encoding: "utf8" });
      out(w.status === 0 ? "Installed the crontab entry." : `Could not edit crontab — install this line yourself:\n\n  ${cronLine}`);
      out();
    } else if (wakeup === "print") {
      out("Install this crontab line when you want always-on:");
      out();
      out(`  ${cronLine}`);
      out();
    }
    out(style("1", "Done. Next:"));
    out();
    if (wakeup === "watch") {
      out("  wake the engineer while you try it (Ctrl-C to stop):");
      out();
      out(`  ${env} etium watch --surface github`);
      out();
    }
    if (actAs !== "me") out(`  make sure this machine's gh is signed in as ${agentLogin}`);
    out(`  assign ${agentLogin || "the engineer"} to a GitHub issue to start the first attempt`);
    return 0;
  } finally {
    rl?.close();
  }
}

async function cmdWatch(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      surface: { type: "string", multiple: true },
      every: { type: "string" },
    },
  });
  const surfaces = await loadSurfaces(v.surface ?? []);
  // 15s default: half of cron's floor (watch is the try-it-out mode), well
  // inside gh's rate budget. Floor 5s; garbage input falls back, not NaN
  // (Math.max(5, NaN) is NaN — a zero-delay hot loop against GitHub).
  const n = Number(v.every ?? "15");
  const everyMs = Math.max(5, Number.isFinite(n) ? n : 15) * 1000;
  process.stdout.write(`watching every ${everyMs / 1000}s — Ctrl-C to stop\n`);
  await watchLoop(base(v.dir), entry, surfaces, everyMs, (actions) => {
    for (const a of actions)
      if (a.action !== "skip-completed" && a.action !== "skip-parked")
        process.stdout.write(`${a.run.padEnd(36)} ${a.action}${a.detail ? `  (${a.detail})` : ""}\n`);
  });
  return 0;
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

function cmdRebuild(argv: string[]): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
    allowPositionals: true,
  });
  if (!positionals[0]) {
    process.stderr.write("usage: etium rebuild <run>\n");
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
      case "watch":
        return await cmdWatch(rest);
      case "init":
        return await cmdInit(rest);
      case "rebuild":
        return cmdRebuild(rest);
      case "clone-loop":
        return cmdCloneLoop(rest);
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

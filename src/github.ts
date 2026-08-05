// The built-in `github` surface (§10.3, ADR-012): loop-agnostic
// infrastructure connecting GitHub to any etium loop. Commands are comments,
// never labels. A `/et …` comment on an open issue with no active attempt →
// a task running ETIUM_GH_LOOP, the text riding in as the `directive` param
// (ADR-023); `/et <word> [note]` comments by trusted authors → gate
// decisions (an exact word is matched against whichever open gate declares
// it; anything else is delivered as `consider` when declared, and with
// no open gate at all it becomes an operator note in the run's mailbox —
// mid-stage words are never dropped, ADR-033); issue close /
// PR close / PR merge → abandons or wrap-up. Outbound is append-only
// narration (ADR-029): one comment per tick covering the run's notable
// ledger events since the last posted marker — state changes, gate
// openings with their commands and the shown artifact's key points +
// links pinned to that round's exact commit (ADR-032), decisions,
// completion. Nothing is ever edited; labels are
// write-only decoration (et:working | et:waiting | et:blocked). All GitHub
// access goes through the `gh` CLI — auth stays gh's problem, per
// MODEL_AUTH's delegation principle.
//
// Identity and trust are not configured (ADR-022): the surface acts as the
// deployment's own repo-scoped gh sign-in (stored under the workdir's
// .etium/gh — see ghConfigDir), and anyone GitHub lets push (Write) may
// command — authorization delegates to the repository's own permission
// model, checked live and fail-closed.
//
// Config (env): ETIUM_GH_REPO (owner/name, required), ETIUM_GH_LOOP (loop
// module path, required), ETIUM_GH_WORKDIR (the checkout to branch from;
// default cwd), ETIUM_GH_BASE (PR base branch, default main), ETIUM_GH_CMD
// (gh binary override; tests point this at a stub).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultParams, ghConfigDir } from "./config.ts";
import { readLedger } from "./ledger.ts";
import type { AnyEnvelope, GateOpenedData, RunView, Surface, SurfaceDecision, SurfacePollResult, SurfaceTask } from "./types.ts";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`github surface: ${k} is required`);
  return v;
};
const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
const REPO = () => env("ETIUM_GH_REPO");
const PREFIX = "/et";
const GH_TIMEOUT_MS = 15_000;
const ghDir = () => ghConfigDir(path.resolve(process.env.ETIUM_GH_WORKDIR ?? process.cwd()));

function gh(args: string[], input?: unknown): unknown {
  const r = spawnSync(GH(), args, {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GH_CONFIG_DIR: ghDir() },
    timeout: GH_TIMEOUT_MS,
  });
  if (r.error) {
    const cmd = args.slice(0, 3).join(" ");
    if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error(`gh ${cmd} timed out after ${GH_TIMEOUT_MS}ms`);
    throw new Error(`gh ${cmd}: ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${(r.stderr || "").trim()}`);
  const out = (r.stdout || "").trim();
  if (!out) return undefined;
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}
const api = (p: string) => gh(["api", p]);
const post = (p: string, body: unknown) => gh(["api", "-X", "POST", p, "--input", "-"], body);
const del = (p: string) => {
  try {
    gh(["api", "-X", "DELETE", p]);
  } catch {
    /* 404 = already absent; decoration is best-effort */
  }
};

interface Issue { number: number; state: string; title: string; body?: string; pull_request?: unknown; assignees?: { login: string }[] }
interface Comment { id: number; body: string; created_at: string; user: { login: string } }

let agentLogin: string | undefined;
const agent = (): string => (agentLogin ??= (api("user") as { login: string }).login);

/** Trust is the repository's own permission model (ADR-022): anyone GitHub
 * lets push may command. Cached per poll; lookup failures fail closed (§8). */
function canCommand(login: string, cache: Map<string, boolean>): boolean {
  let v = cache.get(login);
  if (v === undefined) {
    try {
      const p = (api(`repos/${REPO()}/collaborators/${encodeURIComponent(login)}/permission`) as { permission?: string })?.permission;
      v = p === "admin" || p === "write" || p === "maintain";
    } catch {
      v = false;
    }
    cache.set(login, v);
  }
  return v;
}


function parseCommand(body: string): { word: string; note?: string } | null {
  const m = /^\s*\/et\s+([a-z][\w-]*)\s*([\s\S]*)$/i.exec(body) ??
    new RegExp(`^\\s*@${agent()}\\s+([a-z][\\w-]*)\\s*([\\s\\S]*)$`, "i").exec(body);
  if (!m) return null;
  return { word: m[1]!.toLowerCase(), note: m[2]?.trim() || undefined };
}

const activeFor = (runs: RunView[], issueN: number): RunView | undefined =>
  runs.find((r) => r.params.issue === String(issueN) && r.params.surface === "github" && !r.completed);

function prFor(view: RunView): { number: number; state: string; merged_at?: string | null } | undefined {
  if (!view.worktree) return undefined;
  const owner = REPO().split("/")[0]!;
  const prs = (api(`repos/${REPO()}/pulls?head=${owner}:${view.worktree.branch}&state=all`) ?? []) as {
    number: number; state: string; merged_at?: string | null;
  }[];
  return prs[0];
}

function commandLines(g: GateOpenedData): string[] {
  const lines = ["reply with one of: " + g.options.filter((o) => o !== "consider").map((o) => `\`${PREFIX} ${o}\``).join(" · ")];
  if (g.options.includes("consider")) lines.push(`…or just say what you want: \`${PREFIX} <your words>\` (\`${PREFIX} stop\` abandons)`);
  return lines;
}

// Never excerpt raw lines (ADR-029) and never call a model (Invariant 1):
// summaries are extracted mechanically, so writing them is the persona's
// job. Verdict-style documents (a VERDICT:/ACTION: first line) summarize
// as that line plus their headings — the objection keys ARE the content.
// Prose documents carry a single "SUMMARY:" line near the top (the
// templates require it), quoted verbatim here. Plus a link pinned to
// the round's commit (only once the file is actually committed).
function keyPoints(view: RunView, src?: string, sha?: string): string[] {
  const p = src ? [view.workspace, view.dir].map((d) => path.join(d, src)).find((f) => fs.existsSync(f)) : undefined;
  if (!p || !src) return [];
  const text = fs.readFileSync(p, "utf8").split("\n");
  const first = text.find((l) => l.trim())?.trim();
  const out: string[] = [];
  const summary = text.map((l) => /^SUMMARY:\s*(.+)/.exec(l.trim())?.[1]).find(Boolean);
  if (summary) {
    out.push(summary.length > 600 ? `${summary.slice(0, 600)}…` : summary);
  } else if (first && /^[A-Z]+:/.test(first)) {
    out.push(`**${first}**`);
    out.push(...text.filter((l) => /^#{1,3} /.test(l)).map((l) => `- ${l.replace(/^#+ /, "")}`));
  }
  const ref = sha || view.worktree?.branch;
  if (ref && spawnSync("git", ["-C", view.workspace, "cat-file", "-e", `HEAD:${src}`]).status === 0)
    out.push(`[${src}](https://github.com/${REPO()}/blob/${ref}/${encodeURI(src)})`);
  return out;
}

const NOTABLE = new Set(["run.created", "step.started", "step.completed", "gate.opened", "gate.decided", "budget.exceeded", "run.completed", "effect.recorded"]);

/** One appended comment per tick, narrating the ledger's notable events
 * since the last posted marker — state changes, never a rewritten status
 * (ADR-029). Consecutive complete→start pairs read as one transition. */
function transitionsBody(view: RunView, events: AnyEnvelope[], marker: string): string | undefined {
  type Item = { done?: string; doneMd?: string; start?: string; lines: string[] };
  // Each artifact-bearing step pairs with the sha its commit recorded (the
  // loop's "sha" effect, first one after the step) — links pin the exact
  // version of that round's document, immune to later rounds (ADR-032).
  const nextSha: (string | undefined)[] = new Array(events.length);
  let carry: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    nextSha[i] = carry;
    const e = events[i]!;
    if (e.type === "effect.recorded" && e.data.name === "sha" && typeof e.data.value === "string" && e.data.value) carry = e.data.value;
  }
  const blob = (ref: string, ws: string) => `https://github.com/${REPO()}/blob/${ref}/${encodeURI(ws)}`;
  const items: Item[] = [];
  let seenSha = "";
  events.forEach((e, i) => {
    if (e.type === "effect.recorded") {
      if (e.data.name === "sha" && typeof e.data.value === "string" && e.data.value) seenSha = e.data.value;
    } else if (e.type === "run.created")
      items.push({ lines: [`▶ attempt \`${view.id}\`${view.worktree ? ` on \`${view.worktree.branch}\`` : ""}`] });
    else if (e.type === "step.started" && e.data.name !== "commit")
      items.push({ start: e.data.name, lines: [`▶ **${e.data.name}**`] });
    else if (e.type === "step.completed" && e.data.step.name !== "commit") {
      const ok = e.data.status === "ok" && e.data.passed !== false;
      const ws = e.data.artifacts[0]?.split("/artifacts/")[1];
      const md = ws && nextSha[i] ? `[**${e.data.step.name}**](${blob(nextSha[i]!, ws)})` : `**${e.data.step.name}**`;
      items.push({ done: ok ? e.data.step.name : undefined, doneMd: md, lines: [`${ok ? "✓" : "✗"} ${md} ${e.data.status}${e.data.passed === false ? " — did not pass" : ""}`] });
    } else if (e.type === "gate.opened") {
      const g = e.data;
      items.push({ lines: [g.reason ? `⏸ **${g.name}** — ${g.reason}` : `⏸ waiting on **${g.name}**`, ...commandLines(g), ...keyPoints(view, g.show[0], seenSha)] });
    } else if (e.type === "gate.decided")
      items.push({ lines: [`◆ **${e.data.name}**: ${e.data.decision} by ${e.data.by}${e.data.note ? ` — ${e.data.note}` : ""}`] });
    else if (e.type === "budget.exceeded")
      items.push({ lines: [`⛔ budget ${e.data.budget} exceeded (${e.data.step.name})`] });
    else if (e.type === "run.completed")
      items.push({ lines: [`**${e.data.status}**${e.data.summary ? ` — ${e.data.summary}` : ""}`] });
  });
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const b = items[i + 1];
    if (a.done && b?.start) {
      lines.push(`${a.doneMd ?? `**${a.done}**`} complete → **${b.start}**`);
      i++;
    } else lines.push(...a.lines);
  }
  if (!lines.length) return undefined;
  if (events.some((e) => e.type === "run.completed")) {
    const tok = view.usage.tokensIn + view.usage.tokensOut;
    if (tok) lines.push(`usage: ${tok} tokens${view.usage.costUsd ? ` · $${view.usage.costUsd.toFixed(4)}` : ""}`);
  }
  return [marker, ...lines].join("\n");
}

const surface: Surface = {
  id: "github",

  poll({ cursor, runs }): SurfacePollResult {
    // Fail fast and legibly on broken auth: every call below dies anyway, but
    // the operator deserves the remedy, not a pile of raw gh stderr.
    const who = spawnSync(GH(), ["auth", "status"], {
      encoding: "utf8",
      env: { ...process.env, GH_CONFIG_DIR: ghDir() },
      timeout: GH_TIMEOUT_MS,
    });
    if (who.error) {
      if ((who.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
        throw new Error(`gh auth status timed out after ${GH_TIMEOUT_MS}ms`);
      throw new Error("gh CLI not found — install: curl -sS https://webi.sh/gh | sh");
    }
    if (who.status !== 0)
      throw new Error(`no deployment sign-in (${ghDir()}) — run: etium configure`);
    const can = new Map<string, boolean>();
    // Events, not state (ADR-023): a fresh deployment's cursor starts at
    // now, so history never mass-triggers on the first tick.
    const now = new Date().toISOString();
    // Cursor v2 (ADR-030): `<lastCommentId>@<lastSeenISO>` — ids are the
    // authority (monotonic, clock-free; comment edits keep their id and so
    // never redeliver), the timestamp only feeds GitHub's `since` filter,
    // fetched with a 2-minute overlap so listing lag can't lose a comment.
    // A bare ISO cursor is the pre-v2 format: adopt its time, ids from 0,
    // no overlap on that one tick (avoids redelivering the old boundary).
    const v2 = /^(\d+)@(.+)$/.exec(cursor ?? "");
    let lastId = v2 ? Number(v2[1]) : 0;
    let lastSeen = v2 ? v2[2]! : (cursor ?? now);
    const since = v2 ? new Date(Date.parse(lastSeen) - 120_000).toISOString() : lastSeen;
    const tasks: SurfaceTask[] = [];
    const decisions: SurfaceDecision[] = [];
    const abandons: NonNullable<SurfacePollResult["abandons"]> = [];
    const notes: NonNullable<SurfacePollResult["notes"]> = [];

    // Lifecycle for every active run, event-independent: close and merge
    // must land no matter what happened to comments or assignment. Also
    // index active runs by issue and PR number for command routing.
    const byNum = new Map<number, RunView>();
    for (const v of runs) {
      if (v.params.surface !== "github" || !v.params.issue || v.completed) continue;
      const n = Number(v.params.issue);
      byNum.set(n, v);
      try {
        const issue = api(`repos/${REPO()}/issues/${n}`) as Issue;
        if (issue.state === "closed") {
          abandons.push({ run: v.id, reason: "issue closed" });
          continue;
        }
      } catch {
        continue; /* unreadable now: leave it for the next tick */
      }
      const pr = prFor(v);
      if (pr) byNum.set(pr.number, v);
      if (pr?.merged_at) {
        const route = v.openGates.find((g) => g.options.includes("wrap-up"));
        if (route) decisions.push({ run: v.id, gate: route.name, decision: "wrap-up", by: "merge" });
        else abandons.push({ run: v.id, reason: "PR merged (human override)" });
      } else if (pr && pr.state === "closed") {
        abandons.push({ run: v.id, reason: "PR closed unmerged" });
      }
    }

    // One repo-wide call: every new issue/PR conversation comment since the
    // cursor, in event order.
    const comments = ((api(`repos/${REPO()}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`) ?? []) as (Comment & { issue_url?: string })[])
      .filter((c) => c.id > lastId && c.created_at > since) // id = authority; created_at floor keeps edited history inert
      .sort((a, b) => a.id - b.id);
    for (const c of comments) {
      if (c.id > lastId) lastId = c.id;
      if (c.created_at > lastSeen) lastSeen = c.created_at;
    }

    const kicked = new Set<number>();
    for (const c of comments) {
      const n = Number(/\/issues\/(\d+)$/.exec(c.issue_url ?? "")?.[1] ?? NaN);
      if (!n) continue;
      const cmd = parseCommand(c.body);
      if (!cmd || !canCommand(c.user.login, can)) continue;
      const active = byNum.get(n);
      if (!active) {
        // Kickoff (ADR-023): `/et <anything>` by a Write-holder starts an
        // attempt; the text rides in as the directive. A bare `stop` with
        // nothing running stays inert.
        if (cmd.word === "stop" || kicked.has(n)) continue;
        const issue = api(`repos/${REPO()}/issues/${n}`) as Issue;
        if (issue.state !== "open" || issue.pull_request) continue;
        kicked.add(n);
        const attempt = runs.filter((r) => r.params.issue === String(n)).length;
        tasks.push({
          key: `issue-${n}#${attempt}`,
          task: `# ${issue.title}\n\n${issue.body ?? ""}\n`,
          loop: env("ETIUM_GH_LOOP"),
          // Deployment-default params ride under the task's own (ADR-025).
          params: {
            ...defaultParams(path.join(path.resolve(process.env.ETIUM_GH_WORKDIR ?? process.cwd()), ".etium")),
            issue: String(n),
            directive: [cmd.word, cmd.note].filter(Boolean).join(" "),
          },
          worktree: {
            repo: process.env.ETIUM_GH_WORKDIR ?? process.cwd(),
            branch: `etium/issue-${n}-attempt-${attempt}`,
            // The engineer's commits are authored as the acting account.
            identity: { name: agent(), email: `${agent()}@users.noreply.github.com` },
          },
        });
        continue;
      }
      if (cmd.word === "stop") {
        abandons.push({ run: active.id, reason: cmd.note ?? `stopped by ${c.user.login}` });
        continue;
      }
      const exact = active.openGates.filter((g) => g.options.includes(cmd.word));
      if (exact.length === 1) {
        decisions.push({ run: active.id, gate: exact[0]!.name, decision: cmd.word, note: cmd.note, by: c.user.login });
        continue;
      }
      // Freestyle: a gate that declares `consider` receives the whole
      // message as its note; the loop's interpreter maps it (ADR-023).
      const fre = active.openGates.find((g) => g.options.includes("consider"));
      if (fre) {
        decisions.push({ run: active.id, gate: fre.name, decision: "consider", note: [cmd.word, cmd.note].filter(Boolean).join(" "), by: c.user.login });
        continue;
      }
      // No gate to receive it: the operator spoke mid-stage. Never dropped —
      // it lands in the run's notes mailbox, and the loop delivers it to the
      // stage's builder and reviewer prompts (ADR-033).
      notes.push({ run: active.id, ts: c.created_at, by: c.user.login, text: [cmd.word, cmd.note].filter(Boolean).join(" "), key: String(c.id) });
    }

    return { tasks, decisions, abandons, notes, cursor: `${lastId}@${lastSeen > now ? lastSeen : now}` };
  },

  project(view: RunView): void {
    const issueN = view.params.issue;
    if (view.params.surface !== "github" || !issueN) return;

    // Push the attempt branch; make the work reviewable as a draft PR once
    // the branch has commits past its recorded base (loop-agnostic — GitHub
    // refuses zero-commit PRs anyway).
    if (view.worktree && fs.existsSync(view.workspace)) {
      const pushed = spawnSync("git", ["-C", view.workspace, "push", "-q", "-u", "origin", view.worktree.branch], {
        encoding: "utf8",
      });
      const head = spawnSync("git", ["-C", view.workspace, "rev-parse", "HEAD"], { encoding: "utf8" });
      const hasCommits = (head.stdout || "").trim() !== view.worktree.baseSha;
      if (pushed.status === 0 && hasCommits && !prFor(view)) {
        post(`repos/${REPO()}/pulls`, {
          title: `etium: ${view.id}`,
          head: view.worktree.branch,
          base: process.env.ETIUM_GH_BASE ?? "main",
          draft: true,
          body: `Automated attempt for #${issueN} (run \`${view.id}\`).\n\nCloses #${issueN}`,
        });
      }
    }

    // Append-only narration (ADR-029): nothing is ever edited — the thread
    // is the run's history. The last posted marker is the projection cursor.
    const comments = (api(`repos/${REPO()}/issues/${issueN}/comments?per_page=100`) ?? []) as Comment[];
    let lastSeq = 0;
    const markerRe = new RegExp(`<!-- et:seq ${view.id} (\\d+) -->`);
    for (const c of comments) {
      const m = markerRe.exec(c.body);
      if (m) lastSeq = Math.max(lastSeq, Number(m[1]));
    }
    const evts = readLedger(view.dir).filter((e) => e.seq > lastSeq && NOTABLE.has(e.type));
    if (evts.length) {
      const body = transitionsBody(view, evts, `<!-- et:seq ${view.id} ${evts.at(-1)!.seq} -->`);
      if (body) post(`repos/${REPO()}/issues/${issueN}/comments`, { body });
    }

    // Decoration labels: write-only, mutually exclusive, best-effort.
    const desired = view.completed
      ? view.completed.status === "error" ? "et:blocked" : undefined
      : view.openGates.length ? "et:waiting" : "et:working";
    for (const l of ["et:working", "et:waiting", "et:blocked"])
      if (l !== desired) del(`repos/${REPO()}/issues/${issueN}/labels/${encodeURIComponent(l)}`);
    if (desired) {
      try {
        post(`repos/${REPO()}/labels`, { name: desired, color: "1f6feb" });
      } catch {
        /* exists */
      }
      post(`repos/${REPO()}/issues/${issueN}/labels`, { labels: [desired] });
    }
  },
};

export default surface;

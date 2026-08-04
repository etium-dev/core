// The built-in `github` surface (§10.3, ADR-012): loop-agnostic
// infrastructure connecting GitHub to any etium loop. Commands are comments,
// never labels. A `/et …` comment on an open issue with no active attempt →
// a task running ETIUM_GH_LOOP, the text riding in as the `directive` param
// (ADR-023); `/et <word> [note]` comments by trusted authors → gate
// decisions (an exact word is matched against whichever open gate declares
// it; anything else is delivered as `consider` when declared); issue close /
// PR close / PR merge → abandons or wrap-up; one bot status comment
// (idempotently rewritten) lists the currently-valid commands; labels are
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
import type { RunView, Surface, SurfaceDecision, SurfacePollResult, SurfaceTask } from "./types.ts";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`github surface: ${k} is required`);
  return v;
};
const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
const REPO = () => env("ETIUM_GH_REPO");
const PREFIX = "/et";
const ghDir = () => ghConfigDir(path.resolve(process.env.ETIUM_GH_WORKDIR ?? process.cwd()));

function gh(args: string[], input?: unknown): unknown {
  const r = spawnSync(GH(), args, {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, GH_CONFIG_DIR: ghDir() },
  });
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
const patch = (p: string, body: unknown) => gh(["api", "-X", "PATCH", p, "--input", "-"], body);
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

function statusBody(view: RunView): string {
  const lines = [`<!-- et:status ${view.id} -->`, `**AI engineer** — run \`${view.id}\``];
  if (view.completed) {
    lines.push(`state: **${view.completed.status}**${view.completed.summary ? ` — ${view.completed.summary}` : ""}`);
  } else if (view.openGates.length) {
    for (const g of view.openGates) {
      lines.push(`waiting on **${g.name}** — reply with one of:`);
      lines.push(g.options.filter((o) => o !== "consider").map((o) => `\`${PREFIX} ${o}\``).join(" · "));
      if (g.options.includes("consider")) lines.push(`…or just say what you want: \`${PREFIX} <your words>\``);
      // Context excerpt: the gate's first shown artifact — the stage's
      // document, the reviewer's objection, the interpreter's question.
      const src = g.show[0];
      const p = src ? [view.workspace, view.dir].map((d) => path.join(d, src)).find((f) => fs.existsSync(f)) : undefined;
      if (p) {
        const ex = fs.readFileSync(p, "utf8").split("\n").slice(0, 8).join("\n").trim();
        if (ex) lines.push("", "```", ex, "```");
      }
    }
    lines.push(`(add a note after the command; \`${PREFIX} stop\` abandons the attempt)`);
  } else {
    lines.push(`state: **working** (${view.status})`);
  }
  const tok = view.usage.tokensIn + view.usage.tokensOut;
  if (tok) lines.push(`usage: ${tok} tokens${view.usage.costUsd ? ` · $${view.usage.costUsd.toFixed(4)}` : ""}`);
  if (view.lastEventTs) lines.push(`updated: ${view.lastEventTs}`);
  return lines.join("\n");
}

const surface: Surface = {
  id: "github",

  poll({ cursor, runs }): SurfacePollResult {
    // Fail fast and legibly on broken auth: every call below dies anyway, but
    // the operator deserves the remedy, not a pile of raw gh stderr.
    const who = spawnSync(GH(), ["auth", "status"], { encoding: "utf8", env: { ...process.env, GH_CONFIG_DIR: ghDir() } });
    if (who.error) throw new Error("gh CLI not found — install: curl -sS https://webi.sh/gh | sh");
    if (who.status !== 0)
      throw new Error(`no deployment sign-in (${ghDir()}) — run: etium configure`);
    const can = new Map<string, boolean>();
    // Events, not state (ADR-023): a fresh deployment's cursor starts at
    // now, so history never mass-triggers on the first tick.
    const now = new Date().toISOString();
    const since = cursor ?? now;
    const tasks: SurfaceTask[] = [];
    const decisions: SurfaceDecision[] = [];
    const abandons: NonNullable<SurfacePollResult["abandons"]> = [];

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
      .filter((c) => c.created_at > since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

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
      if (fre)
        decisions.push({ run: active.id, gate: fre.name, decision: "consider", note: [cmd.word, cmd.note].filter(Boolean).join(" "), by: c.user.login });
    }

    return { tasks, decisions, abandons, cursor: now };
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

    // One bot-owned status comment, rewritten in place (never read back).
    const marker = `<!-- et:status ${view.id} -->`;
    const body = statusBody(view);
    const existing = ((api(`repos/${REPO()}/issues/${issueN}/comments?per_page=100`) ?? []) as Comment[])
      .find((c) => c.body.startsWith(marker));
    if (existing) {
      if (existing.body !== body) patch(`repos/${REPO()}/issues/comments/${existing.id}`, { body });
    } else {
      post(`repos/${REPO()}/issues/${issueN}/comments`, { body });
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

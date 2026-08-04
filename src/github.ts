// The built-in `github` surface (§10.3, ADR-012): loop-agnostic
// infrastructure connecting GitHub to any etium loop. Commands are comments,
// never labels. Assignment of the agent user → a task running ETIUM_GH_LOOP;
// `/et <word> [note]` comments by trusted authors → gate decisions (the word
// is matched against whichever open gate declares it); issue close / PR
// close / PR merge → abandons or wrap-up; one bot status comment
// (idempotently rewritten) lists the currently-valid commands; labels are
// write-only decoration (et:working | et:waiting | et:blocked). All GitHub
// access goes through the `gh` CLI — auth stays gh's problem, per
// MODEL_AUTH's delegation principle.
//
// Identity and trust are not configured (ADR-022): the surface acts as the
// deployment's own repo-scoped gh sign-in (stored under the workdir's
// .etium/gh — see ghConfigDir), its assignment starts attempts, and anyone
// GitHub lets push (Write) may command — authorization delegates to the
// repository's own permission model, checked live and fail-closed.
//
// Config (env): ETIUM_GH_REPO (owner/name, required), ETIUM_GH_LOOP (loop
// module path, required), ETIUM_GH_WORKDIR (the checkout to branch from;
// default cwd), ETIUM_GH_BASE (PR base branch, default main), ETIUM_GH_CMD
// (gh binary override; tests point this at a stub).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ghConfigDir } from "./config.ts";
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

/** Last assignment of the agent must come from someone with Write (invariant 6). */
function assignedByAuthorized(issueN: number, can: Map<string, boolean>): boolean {
  const tl = (api(`repos/${REPO()}/issues/${issueN}/timeline?per_page=100`) ?? []) as {
    event?: string; assignee?: { login: string }; actor?: { login: string };
  }[];
  const last = [...tl].reverse().find((e) => e.event === "assigned" && e.assignee?.login === agent());
  return !!last && canCommand(last.actor?.login ?? "", can);
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
      lines.push(g.options.map((o) => `\`${PREFIX} ${o}\``).join(" · "));
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
    const since = cursor ?? new Date(0).toISOString();
    const now = new Date().toISOString();
    const tasks: SurfaceTask[] = [];
    const decisions: SurfaceDecision[] = [];
    const abandons: NonNullable<SurfacePollResult["abandons"]> = [];

    const issues = ((api(`repos/${REPO()}/issues?assignee=${agent()}&state=all&per_page=100`) ?? []) as Issue[])
      .filter((i) => !i.pull_request);

    for (const issue of issues) {
      const active = activeFor(runs, issue.number);

      // Ownership → task (open, assigned, no active run, trusted assigner).
      if (issue.state === "open" && !active) {
        if (!assignedByAuthorized(issue.number, can)) continue;
        const attempt = runs.filter((r) => r.params.issue === String(issue.number)).length;
        tasks.push({
          key: `issue-${issue.number}#${attempt}`,
          task: `# ${issue.title}\n\n${issue.body ?? ""}\n`,
          loop: env("ETIUM_GH_LOOP"),
          params: { issue: String(issue.number) },
          worktree: {
            repo: process.env.ETIUM_GH_WORKDIR ?? process.cwd(),
            branch: `etium/issue-${issue.number}-attempt-${attempt}`,
            // The engineer's commits are authored as the acting account.
            identity: { name: agent(), email: `${agent()}@users.noreply.github.com` },
          },
        });
        continue;
      }
      if (!active) continue;

      // Lifecycle facts.
      if (issue.state === "closed") {
        abandons.push({ run: active.id, reason: "issue closed" });
        continue;
      }
      const pr = prFor(active);
      if (pr?.merged_at) {
        const route = active.openGates.find((g) => g.options.includes("wrap-up"));
        if (route) decisions.push({ run: active.id, gate: route.name, decision: "wrap-up", by: "merge" });
        else abandons.push({ run: active.id, reason: "PR merged (human override)" });
        continue;
      }
      if (pr && pr.state === "closed") {
        abandons.push({ run: active.id, reason: "PR closed unmerged" });
        continue;
      }

      // Commands: comments on the issue and, once it exists, the PR.
      const threads = [issue.number, ...(pr ? [pr.number] : [])];
      const comments = threads
        .flatMap((n) => (api(`repos/${REPO()}/issues/${n}/comments?per_page=100`) ?? []) as Comment[])
        .filter((c) => c.created_at > since)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const c of comments) {
        if (!canCommand(c.user.login, can)) continue;
        const cmd = parseCommand(c.body);
        if (!cmd) continue;
        if (cmd.word === "stop") {
          abandons.push({ run: active.id, reason: cmd.note ?? `stopped by ${c.user.login}` });
          continue;
        }
        const gates = active.openGates.filter((g) => g.options.includes(cmd.word));
        if (gates.length !== 1) continue; // unknown/ambiguous: status comment teaches the valid set
        decisions.push({ run: active.id, gate: gates[0]!.name, decision: cmd.word, note: cmd.note, by: c.user.login });
      }
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

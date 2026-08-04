// The GitHub surface against a stub `gh`: a `/et …` comment from someone
// with Write kickstarts a run (worktree branch, directive param); exact
// `/et <option>` comments decide gates; freestyle text is delivered as a
// `consider` decision; read-only commenters are ignored; `/et stop` and
// issue-close abandon; projection (branch pushed to origin, draft PR once
// artifacts exist, status comment upserted, decoration label added).
// No network, no real GitHub. (ADR-022 identity, ADR-023 events.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLedger } from "../src/ledger.ts";
import { tickOnce } from "../src/tick.ts";
import surface from "../src/github.ts";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.ETIUM_GH_STUB_DIR;
fs.appendFileSync(path.join(dir, "envs.txt"), (process.env.GH_CONFIG_DIR || "-") + "\\n");
const args = process.argv.slice(2); // ["api", ...]
let method = "GET"; let p = ""; let readInput = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "-X") method = args[++i];
  else if (args[i] === "--input") { readInput = true; i++; }
  else if (!p) p = args[i];
}
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return d; } };
if (method === "GET") {
  let out;
  if (p === "user") out = { login: "agentbot" };
  else if (/collaborators\\/([^/]+)\\/permission/.test(p))
    out = { permission: read("permissions.json", {})[decodeURIComponent(p.match(/collaborators\\/([^/]+)\\/permission/)[1])] || "none" };
  else if (/^repos\\/.+\\/issues\\/comments\\?/.test(p)) out = read("repo-comments.json", []);
  else if (/issues\\/(\\d+)$/.test(p)) out = read("issue-" + p.match(/issues\\/(\\d+)$/)[1] + ".json", {});
  else if (/issues\\/(\\d+)\\/comments/.test(p)) out = read("comments-" + p.match(/issues\\/(\\d+)/)[1] + ".json", []); // projection's upsert/escalation scan

  else if (/^repos\\/.+\\/pulls\\?head=/.test(p)) {
    const branch = decodeURIComponent(p.match(/head=[^:]+:([^&]+)/)[1]);
    out = read("prs.json", []).filter((x) => x.head && x.head.ref === branch);
  } else out = {};
  process.stdout.write(JSON.stringify(out));
} else {
  const body = readInput ? fs.readFileSync(0, "utf8") : "";
  fs.appendFileSync(path.join(dir, "writes.jsonl"), JSON.stringify({ method, path: p, body: body && JSON.parse(body) }) + "\\n");
  if (/\\/pulls$/.test(p)) process.stdout.write(JSON.stringify({ number: 90, state: "open" }));
  else if (/\\/comments$/.test(p)) process.stdout.write(JSON.stringify({ id: 501 }));
  else process.stdout.write("{}");
}
`;

const SLOOP = `export default async function (run) {
  await run.step("work", { harness: "exec", artifacts: ["ai/NOTES.md"],
    command: "mkdir -p ai && echo notes-content > ai/NOTES.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm work" });
  await run.effect("sha", () => "cafe1234beef");
  for (;;) {
    const d = await run.gate("route", { options: ["plan", "wrap-up", "consider"], show: ["ai/NOTES.md"], reason: "stub needs a human here" });
    if (d.decision === "wrap-up") return;
    if (d.decision === "plan") {
      await run.step("plan", { harness: "exec", command: "echo planned > planned.txt" });
      await run.step("plan-check", { harness: "exec", command: "true" });
    }
    // consider: record and re-open — interpretation is the real loop's job
  }
}
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ghs-"));
  const stubDir = path.join(root, "stub");
  const workdir = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  const base = path.join(root, ".etium");
  fs.mkdirSync(stubDir);
  fs.mkdirSync(workdir);
  const stubPath = path.join(root, "gh-stub.js");
  fs.writeFileSync(stubPath, STUB, { mode: 0o755 });
  const loopPath = path.join(root, "sloop.ts");
  fs.writeFileSync(loopPath, SLOOP);
  const g = (cwd: string, ...a: string[]) => {
    const r = spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  g(root, "init", "-q", "--bare", bare);
  g(root, "init", "-q", workdir);
  fs.writeFileSync(path.join(workdir, "README.md"), "x\n");
  g(workdir, "add", ".");
  g(workdir, "commit", "-qm", "init");
  g(workdir, "remote", "add", "origin", bare);

  process.env.ETIUM_GH_CMD = stubPath;
  process.env.ETIUM_GH_STUB_DIR = stubDir;
  process.env.ETIUM_GH_REPO = "acme/widgets";
  process.env.ETIUM_GH_WORKDIR = workdir;
  process.env.ETIUM_GH_LOOP = loopPath;
  // Deployment-default params (ADR-025): ride under every task's own params.
  fs.mkdirSync(path.join(workdir, ".etium"), { recursive: true });
  fs.writeFileSync(path.join(workdir, ".etium", "config.json"),
    JSON.stringify({ v: 1, id: "cafe0000", library: "ai-engineer", github: { repo: "acme/widgets", loop: loopPath }, params: { rounds: "7", directive: "config-must-lose" } }));
  // Trust is permission-based (ADR-022): carlospche can push, rando can't.
  fs.writeFileSync(path.join(stubDir, "permissions.json"), JSON.stringify({ carlospche: "write", rando: "read" }));

  const writes = () =>
    fs.existsSync(path.join(stubDir, "writes.jsonl"))
      ? fs.readFileSync(path.join(stubDir, "writes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; path: string; body: { body?: string; labels?: string[] } })
      : [];
  const tick = () => tickOnce(base, "unused-entry", true, [surface]);
  const soon = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  const say = (n: number, id: number, body: string, login: string, at: string) =>
    ({ id, body, created_at: at, user: { login }, issue_url: `https://api.github.com/repos/acme/widgets/issues/${n}` });
  return { root, stubDir, workdir, bare, base, g, writes, tick, soon, say };
}

const fixture = (dir: string, name: string, data: unknown) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));

test("kickoff comment → worktree run with directive; read-only commenter ignored; projection pushes branch, opens draft PR, upserts status, labels", async () => {
  const { stubDir, base, bare, g, writes, workdir, tick, soon, say } = setup();
  fixture(stubDir, "issue-7.json", { number: 7, state: "open", title: "Fix the widget", body: "it wobbles" });
  fixture(stubDir, "issue-9.json", { number: 9, state: "open", title: "Sneaky", body: "" });
  await tick(); // first tick: the cursor starts at "now" — nothing to see yet
  assert.ok(!fs.existsSync(path.join(base, "runs")) || fs.readdirSync(path.join(base, "runs")).length === 0);

  fixture(stubDir, "repo-comments.json", [
    say(7, 1, "/et fix the wobble", "carlospche", soon(1)),
    say(9, 2, "/et do things", "rando", soon(1)),
  ]);
  await tick();

  const runsDir = path.join(base, "runs");
  assert.equal(fs.readdirSync(runsDir).length, 1, "read-permission commenter must not start attempts");
  const runId = fs.readdirSync(runsDir)[0]!;
  const created = readLedger(path.join(runsDir, runId)).find((e) => e.type === "run.created")!
    .data as { params: Record<string, string>; workspace: string; worktree?: { branch: string } };
  assert.equal(created.params.issue, "7");
  assert.equal(created.params.directive, "fix the wobble"); // the human's words ride into triage (ADR-023)
  assert.equal(created.params.rounds, "7"); // deployment params ride along (ADR-025)…
  assert.notEqual(created.params.directive, "config-must-lose"); // …but never override the task's own
  assert.equal(created.worktree?.branch, "etium/issue-7-attempt-0");
  // The engineer's commits author as the acting account (ADR-017).
  const wsIdent = spawnSync("git", ["-C", created.workspace, "config", "user.name"], { encoding: "utf8" });
  assert.equal((wsIdent.stdout || "").trim(), "agentbot");
  assert.ok(g(bare, "for-each-ref", "--format=%(refname:short)").includes("etium/issue-7-attempt-0"), "branch pushed to origin");

  const w = writes();
  assert.ok(w.some((x) => /\/pulls$/.test(x.path) && x.body.body?.includes("Closes #7")), "draft PR created");

  // Append-only narration (ADR-029): one comment covering the events so
  // far, never an edited status.
  assert.ok(!w.some((x) => x.method === "PATCH"), "nothing is ever edited");
  const narr = w.filter((x) => x.method === "POST" && /issues\/7\/comments$/.test(x.path));
  assert.equal(narr.length, 1, "one narration comment per tick");
  const nb = narr[0]!.body.body!;
  assert.match(nb, /<!-- et:seq /); // the projection cursor rides in the marker
  assert.match(nb, /▶ attempt .* on `etium\/issue-7-attempt-0`/);
  assert.match(nb, /▶ \*\*work\*\*/);
  assert.match(nb, /✓ \[\*\*work\*\*\]\(https:\/\/github\.com\/acme\/widgets\/blob\/cafe1234beef\/ai\/NOTES\.md\) ok/,
    "step names link to that round's exact commit (ADR-032)");
  assert.match(nb, /⏸ \*\*route\*\* — stub needs a human here/); // the gate's reason is the headline
  assert.match(nb, /\/et plan/);
  assert.match(nb, /\/et wrap-up/);
  assert.ok(!nb.includes("/et consider"), "consider is internal, not a listed command");
  assert.match(nb, /just say what you want/); // freestyle invitation
  assert.match(nb, /notes-content/); // the artifact's key points, not a raw excerpt…
  assert.ok(!nb.includes("```"), "…never a fenced snippet");
  assert.match(nb, /blob\/cafe1234beef\/ai\/NOTES\.md/); // gate link pinned to the round's commit, not the moving branch
  assert.ok(w.some((x) => /issues\/7\/labels$/.test(x.path) && x.body.labels?.includes("et:waiting")));

  // Once posted comments are visible, a quiet tick appends nothing.
  fixture(stubDir, "repo-comments.json", []);
  fixture(stubDir, "comments-7.json", [{ id: 900, body: nb, created_at: soon(2), user: { login: "agentbot" } }]);
  await tick();
  const narr2 = writes().filter((x) => x.method === "POST" && /issues\/7\/comments$/.test(x.path));
  assert.equal(narr2.length, 1, "no re-narration of already-posted events");
  // Every gh call carried the deployment's own config dir (ADR-022).
  const envs = fs.readFileSync(path.join(stubDir, "envs.txt"), "utf8").trim().split("\n");
  const expected = path.join(workdir, ".etium", "gh");
  assert.ok(envs.length > 0 && envs.every((e) => e === expected), `repo-scoped gh: ${envs[0]}`);
});

test("issue close abandons the active run (lifecycle sweep fetches the issue directly)", async () => {
  const { stubDir, base, tick, soon, say } = setup();
  fixture(stubDir, "issue-7.json", { number: 7, state: "open", title: "Fix", body: "" });
  await tick();
  fixture(stubDir, "repo-comments.json", [say(7, 1, "/et go", "carlospche", soon(1))]);
  await tick(); // creates + parks at route

  fixture(stubDir, "repo-comments.json", []);
  fixture(stubDir, "issue-7.json", { number: 7, state: "closed", title: "Fix", body: "" });
  await tick();

  const runId = fs.readdirSync(path.join(base, "runs"))[0]!;
  const last = readLedger(path.join(base, "runs", runId)).at(-1)!;
  assert.equal(last.type, "run.completed");
  assert.deepEqual(last.data, { status: "abandoned", summary: "issue closed" });
});

test("exact /et word decides; freestyle → consider with the full text; read-only ignored; /et stop abandons; a new /et is attempt #1", async () => {
  const { stubDir, base, writes, tick, soon, say } = setup();
  fixture(stubDir, "issue-7.json", { number: 7, state: "open", title: "Fix", body: "" });
  await tick();
  fixture(stubDir, "repo-comments.json", [say(7, 1, "/et start on this", "carlospche", soon(1))]);
  await tick(); // creates + parks at route

  const runId = fs.readdirSync(path.join(base, "runs"))[0]!;
  const runDir = path.join(base, "runs", runId);
  fixture(stubDir, "repo-comments.json", [
    say(7, 2, "/et plan looks right", "rando", soon(2)),
    say(7, 3, "/et plan start with the retry", "carlospche", soon(3)),
  ]);
  await tick();

  const decided = readLedger(runDir).filter((e) => e.type === "gate.decided");
  assert.equal(decided.length, 1, "untrusted command ignored");
  const d = decided[0]!.data as { decision: string; by: string; via: string; note?: string };
  assert.deepEqual({ decision: d.decision, by: d.by, via: d.via, note: d.note },
    { decision: "plan", by: "carlospche", via: "github", note: "start with the retry" });
  assert.ok(fs.existsSync(path.join(base, "worktrees", runId, "planned.txt")), "loop proceeded on the decision");
  assert.ok(
    writes().some((x) => /issues\/7\/comments$/.test(x.path) && /\*\*plan\*\* complete → \*\*plan-check\*\*/.test(x.body.body ?? "")),
    "adjacent complete→start narrates as one transition",
  );

  // No exact option match → the whole message is delivered as `consider`.
  fixture(stubDir, "repo-comments.json", [
    say(7, 4, "/et actually just wrap this whole thing up", "carlospche", soon(4)),
  ]);
  await tick();
  const consider = readLedger(runDir).filter((e) => e.type === "gate.decided").at(-1)!
    .data as { decision: string; note?: string };
  assert.equal(consider.decision, "consider");
  assert.match(consider.note!, /wrap this whole thing up/);

  fixture(stubDir, "repo-comments.json", [
    say(7, 5, "/et stop enough for today", "carlospche", soon(5)),
  ]);
  await tick();
  const completed = readLedger(runDir).at(-1)!;
  assert.equal(completed.type, "run.completed");
  assert.deepEqual(completed.data, { status: "abandoned", summary: "enough for today" });

  // With no active run, a fresh `/et` comment is a new attempt with a new branch.
  fixture(stubDir, "repo-comments.json", [
    say(7, 6, "/et try again", "carlospche", soon(6)),
  ]);
  await tick();
  const runs = fs.readdirSync(path.join(base, "runs"));
  assert.equal(runs.length, 2, "new kickoff created attempt #1");
  const second = runs.find((r) => r !== runId)!;
  const created2 = readLedger(path.join(base, "runs", second)).find((e) => e.type === "run.created")!
    .data as { params: Record<string, string>; worktree?: { branch: string } };
  assert.equal(created2.worktree?.branch, "etium/issue-7-attempt-1");
  assert.equal(created2.params.directive, "try again");
  assert.ok(writes().length > 0);
});

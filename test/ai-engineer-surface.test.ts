// The GitHub surface against a stub `gh`: assignment → task (with worktree
// branch), trusted `/et` comments → decisions, untrusted ignored, `/et stop`
// and issue-close → abandons, and projection (branch pushed to origin, draft
// PR created once artifacts exist, status comment upserted with the valid
// commands, decoration label added). No network, no real GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLedger } from "../src/ledger.ts";
import { tickOnce } from "../src/tick.ts";
import surface from "../ai-engineer/github.ts";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.ETIUM_GH_STUB_DIR;
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
  else if (/^repos\\/.+\\/issues\\?/.test(p)) out = read("issues.json", []);
  else if (/issues\\/(\\d+)\\/timeline/.test(p)) out = read("timeline-" + p.match(/issues\\/(\\d+)/)[1] + ".json", []);
  else if (/issues\\/(\\d+)\\/comments/.test(p)) out = read("comments-" + p.match(/issues\\/(\\d+)/)[1] + ".json", []);
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
  await run.step("work", { harness: "exec",
    command: "mkdir -p ai && echo intake > ai/INTAKE.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm work" });
  for (;;) {
    const d = await run.gate("route", { options: ["plan", "wrap-up"] });
    if (d.decision === "wrap-up") return;
    await run.step("plan", { harness: "exec", command: "echo planned > planned.txt" });
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
  process.env.ETIUM_GH_TRUSTED = "carlospche";
  process.env.ETIUM_GH_WORKDIR = workdir;
  process.env.ETIUM_GH_LOOP = loopPath;
  process.env.ETIUM_GH_AGENT = "agentbot";

  const writes = () =>
    fs.existsSync(path.join(stubDir, "writes.jsonl"))
      ? fs.readFileSync(path.join(stubDir, "writes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; path: string; body: { body?: string; labels?: string[] } })
      : [];
  return { root, stubDir, workdir, bare, base, g, writes };
}

const fixture = (dir: string, name: string, data: unknown) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));

test("assignment → worktree run; projection pushes branch, opens draft PR, upserts status, labels", async () => {
  const { stubDir, base, bare, g, writes } = setup();
  fixture(stubDir, "issues.json", [
    { number: 7, state: "open", title: "Fix the widget", body: "it wobbles", assignees: [{ login: "agentbot" }] },
  ]);
  fixture(stubDir, "timeline-7.json", [{ event: "assigned", assignee: { login: "agentbot" }, actor: { login: "carlospche" } }]);

  await tickOnce(base, "unused-entry", true, [surface]);

  const runsDir = path.join(base, "runs");
  const runId = fs.readdirSync(runsDir)[0]!;
  const created = readLedger(path.join(runsDir, runId)).find((e) => e.type === "run.created")!
    .data as { params: Record<string, string>; worktree?: { branch: string } };
  assert.equal(created.params.issue, "7");
  assert.equal(created.worktree?.branch, "etium/issue-7-attempt-0");
  assert.ok(g(bare, "for-each-ref", "--format=%(refname:short)").includes("etium/issue-7-attempt-0"), "branch pushed to origin");

  const w = writes();
  assert.ok(w.some((x) => /\/pulls$/.test(x.path) && x.body.body?.includes("Closes #7")), "draft PR created");
  const status = w.find((x) => /issues\/7\/comments$/.test(x.path))!;
  assert.match(status.body.body!, /\/et plan/);
  assert.match(status.body.body!, /\/et wrap-up/);
  assert.ok(w.some((x) => /issues\/7\/labels$/.test(x.path) && x.body.labels?.includes("et:waiting")));
});

test("trusted /et command decides; untrusted ignored; /et stop abandons; issue close abandons", async () => {
  const { stubDir, base, writes } = setup();
  fixture(stubDir, "issues.json", [
    { number: 7, state: "open", title: "Fix", body: "", assignees: [{ login: "agentbot" }] },
  ]);
  fixture(stubDir, "timeline-7.json", [{ event: "assigned", assignee: { login: "agentbot" }, actor: { login: "carlospche" } }]);
  await tickOnce(base, "unused-entry", true, [surface]); // creates + parks at route

  const runId = fs.readdirSync(path.join(base, "runs"))[0]!;
  const runDir = path.join(base, "runs", runId);
  const soon = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  fixture(stubDir, "comments-7.json", [
    { id: 1, body: "/et plan looks right", created_at: soon(1), user: { login: "rando" } },
    { id: 2, body: "/et plan start with the retry", created_at: soon(2), user: { login: "carlospche" } },
  ]);
  await tickOnce(base, "unused-entry", true, [surface]);

  const decided = readLedger(runDir).filter((e) => e.type === "gate.decided");
  assert.equal(decided.length, 1, "untrusted command ignored");
  const d = decided[0]!.data as { decision: string; by: string; via: string; note?: string };
  assert.deepEqual({ decision: d.decision, by: d.by, via: d.via, note: d.note },
    { decision: "plan", by: "carlospche", via: "github", note: "start with the retry" });
  assert.ok(fs.existsSync(path.join(base, "worktrees", runId, "planned.txt")), "loop proceeded on the decision");

  fixture(stubDir, "comments-7.json", [
    { id: 3, body: "/et stop enough for today", created_at: soon(3), user: { login: "carlospche" } },
  ]);
  await tickOnce(base, "unused-entry", true, [surface]);
  const completed = readLedger(runDir).at(-1)!;
  assert.equal(completed.type, "run.completed");
  assert.deepEqual(completed.data, { status: "abandoned", summary: "enough for today" });

  // A later reassignment is a new attempt with a new branch — and a closed
  // issue with an active run abandons it.
  fixture(stubDir, "comments-7.json", []);
  await tickOnce(base, "unused-entry", true, [surface]);
  const runs = fs.readdirSync(path.join(base, "runs"));
  assert.equal(runs.length, 2, "reassignment created attempt #1");
  const second = runs.find((r) => r !== runId)!;
  fixture(stubDir, "issues.json", [
    { number: 7, state: "closed", title: "Fix", body: "", assignees: [{ login: "agentbot" }] },
  ]);
  await tickOnce(base, "unused-entry", true, [surface]);
  const last = readLedger(path.join(base, "runs", second)).at(-1)!;
  assert.deepEqual(last.data, { status: "abandoned", summary: "issue closed" });
  assert.ok(writes().length > 0);
});

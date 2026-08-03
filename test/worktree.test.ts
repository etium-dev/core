// Worktrees per run (§4, M1): each run can get its own git worktree on a
// fresh branch — one branch per attempt, parallel runs isolated by
// construction, recorded in run.created for surfaces to open PRs from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readLedger } from "../src/ledger.ts";
import { createRun } from "../src/supervisor.ts";
import { tickOnce } from "../src/tick.ts";

const GIT = ["-c", "user.name=t", "-c", "user.email=t@t"];
function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...GIT, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function tmpRepo(): { root: string; repo: string; etiumBase: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-wt-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return { root, repo, etiumBase: path.join(root, ".etium") };
}

const NOOP_LOOP = `export default async function (run) {
  await run.step("touch", { harness: "exec", command: "echo done > from-run.txt" });
}
`;
function loopFile(root: string): string {
  const p = path.join(root, "noop.ts");
  fs.writeFileSync(p, NOOP_LOOP);
  return p;
}

test("worktree runs: own branch off base, recorded in run.created, isolated in parallel", () => {
  const { root, repo, etiumBase } = tmpRepo();
  const loop = loopFile(root);
  const a = createRun(etiumBase, { task: "run a", loop, worktree: { repo } });
  const b = createRun(etiumBase, { task: "run b", loop, worktree: { repo } });

  for (const { runId, runDir } of [a, b]) {
    const ws = path.join(etiumBase, "worktrees", runId);
    assert.ok(fs.existsSync(path.join(ws, "README.md")), "worktree checked out from base");
    assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), `etium/${runId}`);
    const created = readLedger(runDir).find((e) => e.type === "run.created")!;
    const data = created.data as { workspace: string; worktree?: { repo: string; branch: string; base: string; baseSha: string } };
    assert.equal(data.workspace, ws);
    const baseSha = git(repo, "rev-parse", "HEAD");
    assert.deepEqual(data.worktree, { repo, branch: `etium/${runId}`, base: "HEAD", baseSha });
  }

  // Parallel isolation: work committed on a's branch is invisible to b and to the repo.
  const wsA = path.join(etiumBase, "worktrees", a.runId);
  fs.writeFileSync(path.join(wsA, "only-a.txt"), "a\n");
  git(wsA, "add", ".");
  git(wsA, "commit", "-qm", "a's work");
  assert.ok(!fs.existsSync(path.join(etiumBase, "worktrees", b.runId, "only-a.txt")));
  assert.ok(!fs.existsSync(path.join(repo, "only-a.txt")));
  assert.ok(git(repo, "branch", "--list", "etium/*").includes(`etium/${a.runId}`));
});

test("worktree failure leaves no half-made run behind", () => {
  const { root, etiumBase } = tmpRepo();
  const loop = loopFile(root);
  const notARepo = path.join(root, "not-a-repo");
  fs.mkdirSync(notARepo);
  assert.throws(
    () => createRun(etiumBase, { task: "doomed", loop, worktree: { repo: notARepo } }),
    /git worktree add failed/,
  );
  const runsDir = path.join(etiumBase, "runs");
  assert.ok(!fs.existsSync(runsDir) || fs.readdirSync(runsDir).length === 0);
});

test("a worktree run executes its steps inside the worktree", async () => {
  const { root, repo, etiumBase } = tmpRepo();
  const loop = loopFile(root);
  const { runId } = createRun(etiumBase, { task: "work here", loop, worktree: { repo } });
  await tickOnce(etiumBase, "unused-entry", true);
  const ws = path.join(etiumBase, "worktrees", runId);
  assert.equal(fs.readFileSync(path.join(ws, "from-run.txt"), "utf8").trim(), "done");
  assert.ok(!fs.existsSync(path.join(repo, "from-run.txt")), "primary checkout untouched");
});

test("explicit branch and base are honored (surface-style creation)", () => {
  const { root, repo, etiumBase } = tmpRepo();
  const loop = loopFile(root);
  git(repo, "tag", "v-base");
  fs.writeFileSync(path.join(repo, "later.txt"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "later");
  const { runId } = createRun(etiumBase, {
    task: "issue 7",
    loop,
    worktree: { repo, base: "v-base", branch: "etium/issue-7-attempt-1" },
  });
  const ws = path.join(etiumBase, "worktrees", runId);
  assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "etium/issue-7-attempt-1");
  assert.ok(!fs.existsSync(path.join(ws, "later.txt")), "branched from v-base, not HEAD");
});

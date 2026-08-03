// `etium clone-loop`: bundled loop libraries are copy-and-own content —
// cloned out of the installed package into the user's repo, never
// overwritten, with .etium/ kept out of the receiving repo's git.

import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.ts";

test("clone-loop: copies the library, ignores .etium/, never overwrites, rejects unknowns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-clone-"));
  const dest = path.join(root, "ai-engineer");

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 0);
  assert.ok(fs.existsSync(path.join(dest, "loop.ts")));
  assert.ok(fs.existsSync(path.join(dest, "TUTORIAL.md")));
  assert.equal(fs.readdirSync(path.join(dest, "templates")).filter((f) => f.endsWith(".md")).length, 7);
  assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").includes(".etium/"));

  const rdest = path.join(root, "ralph");
  assert.equal(await main(["clone-loop", "ralph", "--into", rdest]), 0);
  assert.ok(fs.existsSync(path.join(rdest, "loop.ts")));
  assert.ok(fs.existsSync(path.join(rdest, "README.md"))); // the contract ships with the loop

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 1); // never overwrite
  assert.equal(await main(["clone-loop", "no-such-library"]), 2);
  assert.equal(await main(["clone-loop"]), 0); // bare form lists
});

test("init (flags mode): checks, clones the library, exits 1 outside a repo", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-init-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
  const ok = spawnSync(process.execPath, [cli, "init", "--library", "ai-engineer", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok\s+node/);
  assert.ok(fs.existsSync(path.join(repo, "ai-engineer", "loop.ts")));
  const ok2 = spawnSync(process.execPath, [cli, "init", "--library", "ralph", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.ok(fs.existsSync(path.join(repo, "ralph", "loop.ts")));
  const bare = path.join(root, "empty");
  fs.mkdirSync(bare);
  const bad = spawnSync(process.execPath, [cli, "init", "--library", "none", "--github", "off"], { cwd: bare, encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /needs\s+a repository/);
});

// ADR-030: config is the deployment. A bare `etium tick` in a configured
// repo mounts the configured surfaces (plural contract — the config
// declares, commands loop) and polls; unconfigured, it reconciles runs
// only. `etium run` without --loop defaults to the configured library.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.ts";
import { configuredSurfaces } from "../src/tick.ts";

test("configuredSurfaces: [] when unconfigured; [github] with env injected from config; explicit env wins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-tcfg-"));
  const repo = path.join(root, "repo");
  const base = path.join(repo, ".etium");
  fs.mkdirSync(base, { recursive: true });
  delete process.env.ETIUM_GH_REPO;
  delete process.env.ETIUM_GH_LOOP;
  delete process.env.ETIUM_GH_WORKDIR;

  assert.deepEqual(configuredSurfaces(base), [], "no config → no surfaces");
  fs.writeFileSync(path.join(base, "config.json"),
    JSON.stringify({ v: 1, id: "cafe0000", library: "ai-engineer", github: null }));
  assert.deepEqual(configuredSurfaces(base), [], "github off → no surfaces");

  fs.writeFileSync(path.join(base, "config.json"),
    JSON.stringify({ v: 1, id: "cafe0000", library: "ai-engineer", github: { repo: "acme/w", loop: "ai-engineer/loop.ts" } }));
  const mounted = configuredSurfaces(base);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0]!.id, "github");
  assert.equal(process.env.ETIUM_GH_REPO, "acme/w");
  assert.equal(process.env.ETIUM_GH_LOOP, path.join(repo, "ai-engineer/loop.ts"), "loop resolves against the checkout");
  assert.equal(process.env.ETIUM_GH_WORKDIR, repo);

  // Explicit env is the per-invocation override — config never clobbers it.
  process.env.ETIUM_GH_REPO = "other/repo";
  configuredSurfaces(base);
  assert.equal(process.env.ETIUM_GH_REPO, "other/repo");
  delete process.env.ETIUM_GH_REPO;
  delete process.env.ETIUM_GH_LOOP;
  delete process.env.ETIUM_GH_WORKDIR;
});

test("run without --loop defaults to the configured library (teaching error names it)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-runloop-"));
  const repo = path.join(root, "repo");
  const base = path.join(repo, ".etium");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "config.json"),
    JSON.stringify({ v: 1, id: "cafe0000", library: "ai-engineer", github: null }));

  // The library isn't cloned: creation fails, and the error must name the
  // deployment's own default — proof the config drove the resolution.
  const cli = path.resolve("src/cli.ts");
  const r = spawnSync(process.execPath, [cli, "run", "goal", "--dir", base], { encoding: "utf8", cwd: repo });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ai-engineer\/loop\.ts/);
  assert.match(r.stderr, /clone-loop ai-engineer/);
  assert.ok(!r.stderr.includes("ralph"), "the hardcoded ralph default is gone for configured deployments");
});

test("bare tick in an unconfigured dir reconciles only (no surface, no error)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-baretick-"));
  const base = path.join(root, ".etium");
  fs.mkdirSync(path.join(base, "runs"), { recursive: true });
  delete process.env.ETIUM_GH_REPO;
  assert.equal(await main(["tick", "--dir", base]), 0);
});

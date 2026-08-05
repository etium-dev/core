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
  assert.ok(fs.existsSync(path.join(dest, "README.md"))); // the clone's own contract; the tutorial lives on the web
  assert.equal(fs.readdirSync(path.join(dest, "templates")).filter((f) => f.endsWith(".md")).length, 12);
  assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").includes(".etium/"));

  const rdest = path.join(root, "ralph");
  assert.equal(await main(["clone-loop", "ralph", "--into", rdest]), 0);
  assert.ok(fs.existsSync(path.join(rdest, "loop.ts")));
  assert.ok(fs.existsSync(path.join(rdest, "README.md"))); // the contract ships with the loop

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 1); // never overwrite
  assert.equal(await main(["clone-loop", "no-such-library"]), 2);
  assert.equal(await main(["clone-loop"]), 0); // bare form lists
});

test("clone-loop --replace: moves the existing copy to .old (never deletes), then clones fresh", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-replace-"));
  const dest = path.join(root, "ai-engineer");
  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 0);
  fs.writeFileSync(path.join(dest, "loop.ts"), "// my edited copy\n");

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest, "--replace"]), 0);
  assert.equal(fs.readFileSync(path.join(dest + ".old", "loop.ts"), "utf8"), "// my edited copy\n");
  assert.ok(fs.readFileSync(path.join(dest, "loop.ts"), "utf8").includes("aiEngineer"), "fresh packaged copy in place");

  // A second replace never clobbers the first rollback either.
  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest, "--replace"]), 0);
  assert.ok(fs.existsSync(dest + ".old.2"));
  assert.equal(fs.readFileSync(path.join(dest + ".old", "loop.ts"), "utf8"), "// my edited copy\n");
});

test("clone-loop --replace refuses the library source itself; a pin beside it is fine (ADR-034)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-src-"));
  const src = path.join(root, "srcrepo");
  fs.mkdirSync(path.join(src, "ai-engineer"), { recursive: true });
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "@etium/core" }));
  fs.writeFileSync(path.join(src, "ai-engineer", "loop.ts"), "// SOURCE\n");
  assert.equal(await main(["clone-loop", "ai-engineer", "--into", path.join(src, "ai-engineer"), "--replace"]), 1);
  assert.equal(fs.readFileSync(path.join(src, "ai-engineer", "loop.ts"), "utf8"), "// SOURCE\n", "the source is never clobbered");
  assert.equal(await main(["clone-loop", "ai-engineer", "--into", path.join(src, ".etium", "loop")]), 0);
  assert.ok(fs.existsSync(path.join(src, ".etium", "loop", "loop.ts")), "the deployment pin clones fine");
});

test("configure in the library source: the deployment pins under .etium/loop; the source stays untouched (ADR-034)", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-pin-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "@etium/core" }));
  fs.mkdirSync(path.join(repo, "ai-engineer"));
  fs.writeFileSync(path.join(repo, "ai-engineer", "loop.ts"), "// SOURCE\n");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const gh = path.join(root, "gh-stub");
  fs.writeFileSync(gh, `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *"api user"*) echo botx ;;
  *".permissions.push"*) echo true ;;
esac
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, ETIUM_GH_CMD: gh };
  const r = spawnSync(process.execPath, [cli, "configure", "--library", "ai-engineer", "--github", "acme/w", "--wakeup", "print"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".etium", "config.json"), "utf8"));
  assert.equal(cfg.github.loop, ".etium/loop/loop.ts", "the deployment runs the pin, not the source");
  assert.ok(fs.existsSync(path.join(repo, ".etium", "loop", "loop.ts")));
  assert.ok(!fs.readFileSync(path.join(repo, ".etium", "loop", "loop.ts"), "utf8").includes("// SOURCE"), "pin content is the packaged library");
  assert.equal(fs.readFileSync(path.join(repo, "ai-engineer", "loop.ts"), "utf8"), "// SOURCE\n", "source untouched");
  // Re-run: the pin is kept by default, never silently refreshed.
  fs.writeFileSync(path.join(repo, ".etium", "loop", "PIN-MARK"), "x");
  const r2 = spawnSync(process.execPath, [cli, "configure", "--library", "ai-engineer", "--github", "acme/w", "--wakeup", "print"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(fs.existsSync(path.join(repo, ".etium", "loop", "PIN-MARK")), "re-run keeps the pin");
});

test("configure: sets the git identity itself (from flags when non-interactive; hard-fails without)", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ident-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const gcfg = path.join(root, "gitconfig"); // isolate from the developer's global config
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: gcfg };

  const bad = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /needs\s+a git identity/);

  const ok = spawnSync(
    process.execPath,
    [cli, "configure", "--library", "none", "--github", "off", "--git-name", "Bot Ident", "--git-email", "bot@example.com"],
    { cwd: repo, encoding: "utf8", env },
  );
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Git identity set: Bot Ident <bot@example\.com>/);
  assert.match(fs.readFileSync(gcfg, "utf8"), /bot@example\.com/); // applied, not printed for copy/paste
});

test("configure (flags mode): github wiring — repo-scoped sign-in verified, no env in output, wiring persisted", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-ghw-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const gh = path.join(root, "gh-stub");
  fs.writeFileSync(gh, `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *"api user"*) echo botx ;;
  *".permissions.push"*) echo true ;;
esac
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, ETIUM_GH_CMD: gh };
  const r = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "acme/w", "--wakeup", "print"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deployment is signed in as botx/);
  assert.ok(!r.stdout.includes("ETIUM_GH_"), "wiring is config, not env the user must carry (ADR-030)");
  assert.match(r.stdout, /comment "\/et <what you want>"/);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".etium", "config.json"), "utf8"));
  assert.deepEqual(cfg.github, { repo: "acme/w", loop: "" });
  const helpers = (spawnSync("git", ["-C", repo, "config", "--get-all", "credential.https://github.com.helper"], { encoding: "utf8" }).stdout || "").trimEnd().split("\n");
  assert.equal(helpers[0], "", "empty first entry silences global helpers");
  assert.match(helpers[1]!, /^!GH_CONFIG_DIR='.*\.etium\/gh' '.*' auth git-credential$/, "self-contained helper: repo scope and gh path baked in");
});

test("configure: default harness lands in config params (each referenced harness validated); hand-edited params survive re-runs", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-harness-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  // Hermetic PATH: harness presence/absence must not depend on this machine.
  const env = { ...process.env, PATH: `${stubBin}:/usr/bin:/bin` };
  // Hand-edited per-persona params predate this configure run.
  fs.mkdirSync(path.join(repo, ".etium"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".etium", "config.json"),
    JSON.stringify({ v: 1, id: "deadbeef", library: "none", github: null, params: { "harness.design": "pi", rounds: "3" } }));

  const r = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off", "--harness", "pi"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+harness = pi — ready/);
  assert.match(r.stdout, /ok\s+harness\.design = pi — ready/);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".etium", "config.json"), "utf8"));
  assert.deepEqual(cfg.params, { "harness.design": "pi", rounds: "3", harness: "pi" });
  assert.equal(cfg.id, "deadbeef");

  // An unready harness is an alert with the remedy, not an abort.
  const r2 = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off", "--harness", "codex"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /needs\s+harness = codex: harness codex is not installed/);
  const r3 = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off", "--harness", "nope"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.match(r3.stdout, /needs\s+harness = nope: unknown harness/);
});

test("configure: two etium installs on PATH is a hard failure naming both", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-shadow-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  const mkbin = (name: string) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, "etium"), `#!/bin/sh\necho ${name}\n`, { mode: 0o755 });
    return d;
  };
  const binA = mkbin("binA");
  const binB = mkbin("binB");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${binA}:${binB}:${stubBin}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /needs\s+one etium install/);
  assert.ok(r.stdout.includes(path.join(binA, "etium")));
  assert.ok(r.stdout.includes(path.join(binB, "etium")));
  assert.match(r.stdout, /npm uninstall -g --prefix/);
});

test("configure (flags mode): checks, clones the library, persists wiring, exits 1 outside a repo", () => {
  const cli = path.resolve("src/cli.ts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-init-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a: string[]) => spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
  g("init", "-q"); g("commit", "-qm", "init", "--allow-empty");
  g("config", "user.name", "t"); g("config", "user.email", "t@t");
  const stubBin = path.join(root, "stubbin");
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, "pi"), "#!/bin/sh\necho 0.0.0-stub\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
  const ok = spawnSync(process.execPath, [cli, "configure", "--library", "ai-engineer", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ok\s+node/);
  assert.ok(fs.existsSync(path.join(repo, "ai-engineer", "loop.ts")));
  const cfg1 = JSON.parse(fs.readFileSync(path.join(repo, ".etium", "config.json"), "utf8"));
  assert.equal(cfg1.library, "ai-engineer"); // wiring persisted (ADR-019)
  assert.equal(cfg1.github, null);
  assert.match(cfg1.id, /^[0-9a-f]{8}$/); // minted identity (ADR-020)
  const ok2 = spawnSync(process.execPath, [cli, "configure", "--library", "ralph", "--github", "off"], { cwd: repo, encoding: "utf8", env });
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.ok(fs.existsSync(path.join(repo, "ralph", "loop.ts")));
  const cfg2 = JSON.parse(fs.readFileSync(path.join(repo, ".etium", "config.json"), "utf8"));
  assert.equal(cfg2.library, "ralph"); // re-run overwrites the answers…
  assert.equal(cfg2.id, cfg1.id); // …but never re-mints identity (ADR-020)
  const bare = path.join(root, "empty");
  fs.mkdirSync(bare);
  const bad = spawnSync(process.execPath, [cli, "configure", "--library", "none", "--github", "off"], { cwd: bare, encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /needs\s+a repository/);
});

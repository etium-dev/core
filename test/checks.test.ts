// Headless-setup predicates (ADR-021): the pieces that make configure work
// 100% over ssh — unverifiable-context detection, agent-var omission, and
// credential-storage detection (which picks the wake-up mechanism).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ghUnverifiableHere } from "../src/checks.ts";
import { ghEnv } from "../src/config.ts";
import { TOKEN_READ_SCRIPT } from "../src/ghauth.ts";
import { ghFileAuth } from "../src/wakeup.ts";

test("ghUnverifiableHere: only darwin-over-ssh — everywhere else the probe is definitive", () => {
  assert.equal(ghUnverifiableHere("darwin", { SSH_CONNECTION: "1" }), true);
  assert.equal(ghUnverifiableHere("darwin", { SSH_TTY: "/dev/ttys0" }), true);
  assert.equal(ghUnverifiableHere("darwin", {}), false);
  assert.equal(ghUnverifiableHere("linux", { SSH_CONNECTION: "1" }), false);
});

test("ghEnv: empty agent defers to gh's runtime identity — the var is omitted, never empty", () => {
  const g = { repo: "a/b", trusted: "me", agent: "", loop: "x/loop.ts" };
  assert.ok(!ghEnv(g).includes("ETIUM_GH_AGENT"));
  assert.ok(ghEnv(g).includes("ETIUM_GH_REPO=a/b"));
  assert.ok(ghEnv({ ...g, agent: "bot" }).includes("ETIUM_GH_AGENT=bot"));
});

test("token read script: hidden read pipes the token to gh's stdin intact; empty input fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etium-tok-"));
  const outFile = path.join(dir, "got");
  const stub = path.join(dir, "gh-stub");
  fs.writeFileSync(stub, `#!/bin/sh\ncat > "${outFile}"\necho "$@" > "${outFile}.args"\n`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", ["-c", TOKEN_READ_SCRIPT], {
    input: "sekrit-token-123\n", // piped stdin: stty fails silently, read still line-terminates on Enter
    encoding: "utf8",
    env: { ...process.env, GHBIN: stub },
  });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(outFile, "utf8"), "sekrit-token-123"); // exact bytes, no trailing newline
  assert.match(fs.readFileSync(`${outFile}.args`, "utf8"), /--with-token --insecure-storage/);
  const empty = spawnSync("/bin/sh", ["-c", TOKEN_READ_SCRIPT], { input: "\n", encoding: "utf8", env: { ...process.env, GHBIN: stub } });
  assert.notEqual(empty.status, 0); // empty token = failure, not a silent gh hang
});

test("ghFileAuth: detects gh's file-stored token (the headless-proof mode)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etium-gha-"));
  const yml = path.join(dir, "hosts.yml");
  assert.equal(ghFileAuth(yml), false); // no file: keyring or nothing
  fs.writeFileSync(yml, "github.com:\n    users:\n        bot:\n");
  assert.equal(ghFileAuth(yml), false); // file exists but token lives in the keyring
  fs.writeFileSync(yml, "github.com:\n    users:\n        bot:\n            oauth_token: gho_x\n");
  assert.equal(ghFileAuth(yml), true);
});

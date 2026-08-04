// Headless-setup units (ADR-021, ADR-022): env construction, the hidden
// token read, and ensureGhAuth's flows against a scripted gh — proving the
// repo-scoped identity contract (GH_CONFIG_DIR on every call,
// --insecure-storage on every sign-in, repo-local credential helper)
// without any network or real gh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ghConfigDir, ghEnv } from "../src/config.ts";
import { ensureGhAuth, TOKEN_READ_SCRIPT, tokenCmdHint } from "../src/ghauth.ts";

test("ghEnv: exactly repo and loop — identity and trust are not env (ADR-022)", () => {
  assert.equal(ghEnv({ repo: "a/b", loop: "x/loop.ts" }), "ETIUM_GH_REPO=a/b ETIUM_GH_LOOP=x/loop.ts");
});

test("tokenCmdHint: pre-provisioning targets the repo's own gh home", () => {
  const hint = tokenCmdHint("/tmp/r");
  assert.ok(hint.startsWith(`GH_CONFIG_DIR=${ghConfigDir("/tmp/r")} `));
  assert.ok(hint.includes("--with-token --insecure-storage"));
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

// --- ensureGhAuth against a scripted gh ------------------------------------

function scaffold(authedFromStart: boolean): { repo: string; log: string; stub: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-gha-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  spawnSync("git", ["-C", repo, "init", "-q"]);
  const log = path.join(root, "gh.log");
  const state = path.join(root, "signed-in");
  if (authedFromStart) fs.writeFileSync(state, "");
  const stub = path.join(root, "gh-stub");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
echo "$@ cfg=$GH_CONFIG_DIR" >> "${log}"
case "$*" in
  *"auth login"*) touch "${state}"; exit 0 ;;
  *"auth logout"*) exit 0 ;;
  *"auth status"*) [ -f "${state}" ] && exit 0 || exit 1 ;;
  *"api user"*) echo botty ;;
  *".permissions.push"*) echo true ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return { repo, log, stub };
}

function withStub<T>(stub: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ETIUM_GH_CMD;
  process.env.ETIUM_GH_CMD = stub;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.ETIUM_GH_CMD;
    else process.env.ETIUM_GH_CMD = prev;
  });
}

const helperEntries = (repo: string): string[] =>
  (spawnSync("git", ["-C", repo, "config", "--get-all", "credential.https://github.com.helper"], { encoding: "utf8" }).stdout || "")
    .split("\n")
    .filter((l, i, a) => l !== "" || i < a.length - 1); // keep the deliberate empty first entry, drop the trailing newline artifact

test("ensureGhAuth: already signed in → access verified, credential helper wired repo-locally, every gh call repo-scoped", async () => {
  const { repo, log, stub } = scaffold(true);
  const lines: string[] = [];
  const r = await withStub(stub, () =>
    ensureGhAuth({
      installed: true,
      interactive: false,
      repoDir: repo,
      repo: "acme/widgets",
      out: (t = "") => lines.push(t),
      menu: async () => {
        throw new Error("menu must not open when already signed in");
      },
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.login, "botty");
  const logged = fs.readFileSync(log, "utf8");
  assert.match(logged, /auth status/);
  assert.match(logged, /\.permissions\.push/);
  for (const l of logged.trim().split("\n")) assert.ok(l.endsWith(`cfg=${ghConfigDir(repo)}`), `repo-scoped: ${l}`);
  assert.deepEqual(helperEntries(repo), ["", "!gh auth git-credential"]); // empty first entry silences global helpers (osxkeychain)
});

test("ensureGhAuth: no sign-in, non-interactive → fails with the pre-provision command (agents relay it)", async () => {
  const { repo, stub } = scaffold(false);
  const lines: string[] = [];
  const r = await withStub(stub, () =>
    ensureGhAuth({ installed: true, interactive: false, repoDir: repo, repo: "acme/widgets", out: (t = "") => lines.push(t), menu: async () => "unused" }),
  );
  assert.equal(r.ok, false);
  assert.ok(lines.join("\n").includes(tokenCmdHint(repo)));
});

test("ensureGhAuth: device-flow sign-in is repo-scoped and file-stored (--insecure-storage)", async () => {
  const { repo, log, stub } = scaffold(false);
  let suspended = 0;
  let resumed = 0;
  const r = await withStub(stub, () =>
    ensureGhAuth({
      installed: true,
      interactive: true,
      repoDir: repo,
      repo: "acme/widgets",
      out: () => {},
      menu: async (_t, _e, options) => {
        assert.ok(options.some((o) => o.value === "token") && options.some((o) => o.value === "web"));
        return "web";
      },
      suspendInput: () => suspended++,
      resumeInput: () => resumed++,
    }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.login, "botty");
  assert.equal(suspended, 1, "the tty must be released before gh takes it");
  assert.equal(resumed, 1);
  const login = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .find((l) => l.includes("auth login"))!;
  assert.match(login, /--insecure-storage/, "the token must land in the repo's hosts.yml, never the shared keyring");
  assert.ok(login.includes(`cfg=${ghConfigDir(repo)}`));
  assert.deepEqual(helperEntries(repo), ["", "!gh auth git-credential"]);
});

test("ensureGhAuth: gh missing → the webi gate, no spawn attempts", async () => {
  const lines: string[] = [];
  const r = await ensureGhAuth({
    installed: false,
    interactive: true,
    repoDir: "/nowhere",
    repo: "a/b",
    out: (t = "") => lines.push(t),
    menu: async () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(r.ok, false);
  assert.ok(lines.join("\n").includes("webi.sh/gh"));
});

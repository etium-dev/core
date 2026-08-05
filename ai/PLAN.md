SUMMARY: Add a 15_000 ms timeout to the built-in GitHub surface's `gh()` helper and direct `gh auth status` preflight, keep repo-scoped `GH_CONFIG_DIR`, report timeout errors distinctly, and cover both the auth-preflight and helper-routed API timeout paths with real `tickOnce` tests (`src/github.ts:48`, `src/github.ts:52`, `src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`, `src/github.ts:212`, `src/ghauth.ts:33`, `src/ghauth.ts:90`, `src/tick.ts:186`, `src/tick.ts:188`).

## Review Gate

- `ai/REVIEW.md` approves the prior design (`ai/REVIEW.md:1`).
- The tests must not prove only the auth preflight timeout, because `poll` runs `gh auth status` before helper-routed API calls (`ai/REVIEW.md:5`, `src/github.ts:212`, `src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`).

## Stage 1 - Surface Timeout Implementation

- Define one local timeout constant near `GH()` and `ghDir()` in `src/github.ts`, using `15_000` to match the existing non-interactive GitHub auth checks (`src/github.ts:43`, `src/github.ts:46`, `src/ghauth.ts:33`, `src/ghauth.ts:90`).
- Add `timeout: GH_TIMEOUT_MS` to the `spawnSync(GH(), args, ...)` call in `gh()` while preserving `encoding`, JSON `input`, and `GH_CONFIG_DIR: ghDir()` (`src/github.ts:49`, `src/github.ts:50`, `src/github.ts:51`, `src/github.ts:52`).
- In `gh()`, check `r.error` before `r.status`; if the error code is `ETIMEDOUT`, throw a message shaped as `gh <first args> timed out after 15000ms`, and otherwise keep the existing command-prefixed failure style (`src/github.ts:48`, `src/github.ts:54`, `src/tick.ts:188`).
- Add the same timeout to the direct `spawnSync(GH(), ["auth", "status"], ...)` preflight in `poll`, while preserving the same `GH_CONFIG_DIR: ghDir()` environment (`src/github.ts:209`, `src/github.ts:212`).
- In the auth preflight, distinguish timeout from missing CLI: keep the install guidance for missing `gh`, keep the configure guidance for nonzero auth status, and throw an explicit `gh auth status timed out after 15000ms` error for `ETIMEDOUT` (`src/github.ts:212`, `src/github.ts:213`, `src/github.ts:214`, `src/github.ts:215`, `src/tick.ts:188`).
- Do not change `src/ghauth.ts`; its non-interactive checks already use `timeout: 15_000`, and its login/logout calls are interactive or cleanup behavior outside this surface tick/watch path (`src/ghauth.ts:33`, `src/ghauth.ts:54`, `src/ghauth.ts:57`, `src/ghauth.ts:90`).
- Do not add a timeout to projection's `git push`, because this task covers GitHub CLI calls and that process is `git`, not `gh` (`src/github.ts:341`, `src/github.ts:342`, `src/github.ts:343`).

## Stage 2 - Regression Tests

- Add tests in `test/ai-engineer-surface.test.ts`, which already drives the real GitHub surface through `tickOnce` and injects a fake `gh` using `ETIUM_GH_CMD` (`test/ai-engineer-surface.test.ts:9`, `test/ai-engineer-surface.test.ts:16`, `test/ai-engineer-surface.test.ts:17`, `test/ai-engineer-surface.test.ts:95`, `test/ai-engineer-surface.test.ts:111`).
- Add one fake-CLI test where `auth status` sleeps longer than `GH_TIMEOUT_MS`; call `tickOnce(base, "unused-entry", true, [surface])` and assert a `surface-error` detail includes `github poll: gh auth status timed out after 15000ms` (`src/github.ts:212`, `src/tick.ts:186`, `src/tick.ts:188`, `test/surface.test.ts:152`).
- Add one fake-CLI test where `auth status` exits 0 and the first `gh api` call sleeps longer than `GH_TIMEOUT_MS`; use an empty repo-comments response path as the trigger and assert `surface-error` detail includes the helper command prefix and `timed out after 15000ms` (`src/github.ts:212`, `src/github.ts:265`, `src/github.ts:48`, `src/github.ts:54`, `src/tick.ts:188`).
- The fake CLI should be a real executable script under a temporary directory, not a mocked `spawnSync`, matching the existing no-network GitHub surface pattern (`test/ai-engineer-surface.test.ts:19`, `test/ai-engineer-surface.test.ts:79`, `test/ai-engineer-surface.test.ts:80`).
- Preserve the existing assertion that every fake-CLI invocation receives the repo-scoped `GH_CONFIG_DIR` (`test/ai-engineer-surface.test.ts:179`, `test/ai-engineer-surface.test.ts:180`, `test/ai-engineer-surface.test.ts:181`, `test/ai-engineer-surface.test.ts:182`).

## Stage 3 - Verification

- Run `npm test`, because the project test script is `node --test` (`package.json:44`, `package.json:46`).
- Verify the new timeout tests fail before Stage 1 and pass after Stage 1 by running the new targeted test file first, then the full suite (`test/ai-engineer-surface.test.ts:111`, `src/github.ts:49`, `src/github.ts:212`, `package.json:46`).

## Evidence Commands

`rg --files ai`

```text
ai/REVIEW.md
ai/DESIGN.md
ai/REPLY.md
```

`git branch --show-current`

```text
etium/issue-4-attempt-0
```

`test -f ai/DIAGNOSIS.md; printf '%s\n' $?`

```text
1
```

`rg -n "const GH =|function gh|spawnSync\(GH|const api|const post|const del|auth status|surface-error|ETIUM_GH_CMD =|const tick =|GH_CONFIG_DIR|\"test\":|timeout: 15_000|git.*push" src/github.ts src/ghauth.ts src/tick.ts test/ai-engineer-surface.test.ts test/surface.test.ts package.json ai/REVIEW.md`

```text
test/ai-engineer-surface.test.ts:23:fs.appendFileSync(path.join(dir, "envs.txt"), (process.env.GH_CONFIG_DIR || "-") + "\n");
test/ai-engineer-surface.test.ts:95:  process.env.ETIUM_GH_CMD = stubPath;
test/ai-engineer-surface.test.ts:111:  const tick = () => tickOnce(base, "unused-entry", true, [surface]);
ai/REVIEW.md:5:- The timeout verification can pass by timing out the auth preflight before reaching helper-routed API calls, because `poll` runs `gh auth status` first (`src/github.ts:209`, `src/github.ts:212`), while normal API reads and writes go through `gh()` via `api`, `post`, and `del` (`src/github.ts:48`, `src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`).
test/surface.test.ts:152:  assert.ok(actions.some((a) => a.action === "surface-error" && /broken poll: api down/.test(a.detail ?? "")));
src/ghauth.ts:22:const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
src/ghauth.ts:23:const envFor = (repoDir: string) => ({ ...process.env, GH_CONFIG_DIR: ghConfigDir(repoDir) });
src/ghauth.ts:28:  return `GH_CONFIG_DIR=${ghConfigDir(repoDir)} gh auth login -h github.com --with-token --insecure-storage`;
src/ghauth.ts:33:  const r = spawnSync(GH(), ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15_000, env: envFor(repoDir) });
src/ghauth.ts:54:    const r = spawnSync(GH(), ["auth", "login", "-h", "github.com", "--insecure-storage"], { stdio: "inherit", env });
src/ghauth.ts:57:  spawnSync(GH(), ["auth", "logout", "-h", "github.com"], { stdio: "ignore", env }); // clean slate on re-sign-in
src/ghauth.ts:62:/** Route this repository's git pushes through the deployment's gh sign-in:
src/ghauth.ts:68: * GH_CONFIG_DIR can be assumed. Worktrees inherit repo config. */
src/ghauth.ts:71:  const helper = `!GH_CONFIG_DIR='${ghConfigDir(repoDir)}' '${gh}' auth git-credential`;
src/ghauth.ts:90:  const run = (args: string[]) => spawnSync(GH(), args, { encoding: "utf8", timeout: 15_000, env });
src/tick.ts:55:    | "surface-error";
src/tick.ts:188:    actions.push({ run: "-", action: "surface-error", detail: `${s.id} poll: ${errMsg(e)}` });
src/tick.ts:196:      actions.push({ run: "-", action: "surface-error", detail: `${s.id} task without key` });
src/tick.ts:216:      actions.push({ run: "-", action: "surface-error", detail: `${s.id} task ${tag}: ${errMsg(e)}` });
src/tick.ts:343:          actions.push({ run: v.id, action: "surface-error", detail: `${s.id} project: ${errMsg(e)}` });
package.json:46:    "test": "node --test",
src/github.ts:43:const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
src/github.ts:48:function gh(args: string[], input?: unknown): unknown {
src/github.ts:49:  const r = spawnSync(GH(), args, {
src/github.ts:52:    env: { ...process.env, GH_CONFIG_DIR: ghDir() },
src/github.ts:63:const api = (p: string) => gh(["api", p]);
src/github.ts:64:const post = (p: string, body: unknown) => gh(["api", "-X", "POST", p, "--input", "-"], body);
src/github.ts:65:const del = (p: string) => {
src/github.ts:212:    const who = spawnSync(GH(), ["auth", "status"], { encoding: "utf8", env: { ...process.env, GH_CONFIG_DIR: ghDir() } });
src/github.ts:341:      const pushed = spawnSync("git", ["-C", view.workspace, "push", "-q", "-u", "origin", view.worktree.branch], {
```

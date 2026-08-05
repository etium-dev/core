SUMMARY: Mini-design: add a bounded timeout to every non-interactive GitHub CLI invocation owned by the built-in GitHub surface by routing API calls through the existing `gh()` helper and giving the direct auth preflight the same timeout (`src/github.ts:48`, `src/github.ts:212`); do not change GitHub auth provisioning or git push behavior because those are separate contracts (`src/ghauth.ts:54`, `src/github.ts:341`).

## Style

Mini-design for a small reliability fix; the GitHub surface already centralizes `gh api` calls in `gh(args, input)` and only needs timeout behavior added there plus the one direct non-interactive auth check (`src/github.ts:48`, `src/github.ts:212`).

## Goals

- Prevent `etium tick` and `etium watch` from hanging forever on GitHub CLI calls made by the built-in GitHub surface; both commands load configured surfaces and then invoke tick/watch reconciliation (`src/cli.ts:881`, `src/cli.ts:888`, `src/cli.ts:904`, `src/cli.ts:905`).
- Apply the timeout to the surface’s normal GitHub API reads/writes, because `api`, `post`, and `del` all call `gh()` (`src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`, `src/github.ts:67`).
- Apply the same timeout to the surface’s auth preflight, because it currently calls `spawnSync(GH(), ["auth", "status"], ...)` directly without `timeout` (`src/github.ts:209`, `src/github.ts:212`).
- Keep the existing repo-scoped GitHub auth environment intact; every surface `gh` call must still set `GH_CONFIG_DIR: ghDir()` (`src/github.ts:49`, `src/github.ts:52`, `src/github.ts:212`).

## Non-Goals

- Do not redesign the surface API or cursor model; polling and projection already own GitHub event intake and outbound narration (`src/github.ts:209`, `src/github.ts:333`).
- Do not add retries, backoff, async process management, or cancellation tokens; this task only bounds a stuck synchronous `gh` subprocess (`src/github.ts:31`, `src/github.ts:49`).
- Do not change interactive GitHub sign-in in `src/ghauth.ts`; token/browser login intentionally inherits stdio for human interaction and is not part of surface tick/watch execution (`src/ghauth.ts:46`, `src/ghauth.ts:54`, `src/ghauth.ts:58`, `src/github.ts:206`).
- Do not add a timeout to `git push` in projection as part of this task; that command is `git`, not `gh`, and uses separate push semantics (`src/github.ts:341`, `src/github.ts:344`).

## Chosen Approach

- In `src/github.ts`, define one local timeout constant near `GH()`/`ghDir()` with the same 15-second budget already used by configure’s non-interactive GitHub checks, so surface GitHub subprocess policy is visible beside the surface’s `ETIUM_GH_CMD`/`GH_CONFIG_DIR` wiring (`src/github.ts:43`, `src/github.ts:46`, `src/ghauth.ts:33`, `src/ghauth.ts:90`).
- Add that timeout to the `spawnSync(GH(), args, ...)` options inside `gh()`; this covers `api("user")`, collaborator permission checks, issue/PR reads, comment reads, comment posts, PR creation, and label writes because those paths use `api`, `post`, or `del` (`src/github.ts:48`, `src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`, `src/github.ts:77`, `src/github.ts:85`, `src/github.ts:109`, `src/github.ts:244`, `src/github.ts:265`, `src/github.ts:285`, `src/github.ts:347`, `src/github.ts:359`, `src/github.ts:377`, `src/github.ts:380`, `src/github.ts:384`).
- Add the same timeout to the direct `gh auth status` preflight in `poll`; this is the only non-helper GitHub CLI invocation in `src/github.ts` (`src/github.ts:212`).
- Preserve the current failure shape: the existing `gh()` nonzero path throws an Error that includes the beginning of the `gh` command, and throwing surfaces are already isolated by tick as `surface-error` actions (`src/github.ts:54`, `test/surface.test.ts:141`, `test/surface.test.ts:151`, `test/surface.test.ts:152`).
- Keep `src/ghauth.ts` as-is for this task: non-interactive configure helpers already use `timeout: 15_000` for `repoLogin` and `ensureGhAuth` checks, while the no-timeout calls are interactive login/logout or local shell discovery (`src/ghauth.ts:33`, `src/ghauth.ts:54`, `src/ghauth.ts:57`, `src/ghauth.ts:70`, `src/ghauth.ts:90`).

## Verification

- Add or update a GitHub surface test that uses `ETIUM_GH_CMD` with a stub sleeping longer than the configured surface timeout, then calls `tickOnce(..., [surface])` and asserts the returned actions include `surface-error` rather than hanging; existing tests already inject a stub through `process.env.ETIUM_GH_CMD` and drive the real surface via `tickOnce` (`test/ai-engineer-surface.test.ts:95`, `test/ai-engineer-surface.test.ts:111`, `test/surface.test.ts:151`, `test/surface.test.ts:152`).
- Keep the existing repo-scoped env assertion passing, because adding timeout must not remove `GH_CONFIG_DIR` from surface calls (`test/ai-engineer-surface.test.ts:179`, `test/ai-engineer-surface.test.ts:180`, `test/ai-engineer-surface.test.ts:181`, `test/ai-engineer-surface.test.ts:182`).
- Run `npm test`; the project’s test script is `node --test` (`package.json:44`, `package.json:46`).

## Evidence Commands

`rg --files ai`

```text
ai/REPLY.md
```

`sed -n '1,220p' ai/REPLY.md`

```text
ACTION: design
```

`git branch --show-current`

```text
etium/issue-4-attempt-0
```

`rg -n "ETIUM_GH_CMD|configuredSurfaces|auth status|issues/comments|pulls|labels|spawnSync\\(GH|timeout|scripts|tickOnce|GH_CONFIG_DIR" src/github.ts src/cli.ts src/ghauth.ts test/ai-engineer-surface.test.ts test/surface.test.ts package.json`

```text
test/ai-engineer-surface.test.ts:16:import { tickOnce } from "../src/tick.ts";
test/ai-engineer-surface.test.ts:23:fs.appendFileSync(path.join(dir, "envs.txt"), (process.env.GH_CONFIG_DIR || "-") + "\n");
test/ai-engineer-surface.test.ts:41:  else if (/^repos\/.+\/pulls\?head=/.test(p)) {
test/ai-engineer-surface.test.ts:49:  if (/\/pulls$/.test(p)) process.stdout.write(JSON.stringify({ number: 90, state: "open" }));
test/ai-engineer-surface.test.ts:95:  process.env.ETIUM_GH_CMD = stubPath;
test/ai-engineer-surface.test.ts:109:      ? fs.readFileSync(path.join(stubDir, "writes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { method: string; path: string; body: { body?: string; labels?: string[] } })
test/ai-engineer-surface.test.ts:111:  const tick = () => tickOnce(base, "unused-entry", true, [surface]);
test/ai-engineer-surface.test.ts:121:test("kickoff comment → worktree run with directive; read-only commenter ignored; projection pushes branch, opens draft PR, upserts status, labels", async () => {
test/ai-engineer-surface.test.ts:150:  assert.ok(w.some((x) => /\/pulls$/.test(x.path) && x.body.body?.includes("Closes #7")), "draft PR created");
test/ai-engineer-surface.test.ts:171:  assert.ok(w.some((x) => /issues\/7\/labels$/.test(x.path) && x.body.labels?.includes("et:waiting")));
src/github.ts:3:// never labels. A `/et …` comment on an open issue with no active attempt →
src/github.ts:15:// completion. Nothing is ever edited; labels are
src/github.ts:28:// default cwd), ETIUM_GH_BASE (PR base branch, default main), ETIUM_GH_CMD
src/github.ts:43:const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
src/github.ts:49:  const r = spawnSync(GH(), args, {
src/github.ts:52:    env: { ...process.env, GH_CONFIG_DIR: ghDir() },
src/github.ts:109:  const prs = (api(`repos/${REPO()}/pulls?head=${owner}:${view.worktree.branch}&state=all`) ?? []) as {
src/github.ts:212:    const who = spawnSync(GH(), ["auth", "status"], { encoding: "utf8", env: { ...process.env, GH_CONFIG_DIR: ghDir() } });
src/github.ts:265:    const comments = ((api(`repos/${REPO()}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`) ?? []) as (Comment & { issue_url?: string })[])
src/github.ts:347:        post(`repos/${REPO()}/pulls`, {
src/github.ts:372:    // Decoration labels: write-only, mutually exclusive, best-effort.
src/github.ts:377:      if (l !== desired) del(`repos/${REPO()}/issues/${issueN}/labels/${encodeURIComponent(l)}`);
src/github.ts:380:        post(`repos/${REPO()}/labels`, { name: desired, color: "1f6feb" });
src/github.ts:384:      post(`repos/${REPO()}/issues/${issueN}/labels`, { labels: [desired] });
src/ghauth.ts:22:const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
src/ghauth.ts:23:const envFor = (repoDir: string) => ({ ...process.env, GH_CONFIG_DIR: ghConfigDir(repoDir) });
src/ghauth.ts:28:  return `GH_CONFIG_DIR=${ghConfigDir(repoDir)} gh auth login -h github.com --with-token --insecure-storage`;
src/ghauth.ts:33:  const r = spawnSync(GH(), ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15_000, env: envFor(repoDir) });
src/ghauth.ts:54:    const r = spawnSync(GH(), ["auth", "login", "-h", "github.com", "--insecure-storage"], { stdio: "inherit", env });
src/ghauth.ts:57:  spawnSync(GH(), ["auth", "logout", "-h", "github.com"], { stdio: "ignore", env }); // clean slate on re-sign-in
src/ghauth.ts:68: * GH_CONFIG_DIR can be assumed. Worktrees inherit repo config. */
src/ghauth.ts:70:  const gh = process.env.ETIUM_GH_CMD ?? (spawnSync("/bin/sh", ["-c", "command -v gh"], { encoding: "utf8" }).stdout || "gh").trim();
src/ghauth.ts:71:  const helper = `!GH_CONFIG_DIR='${ghConfigDir(repoDir)}' '${gh}' auth git-credential`;
src/ghauth.ts:90:  const run = (args: string[]) => spawnSync(GH(), args, { encoding: "utf8", timeout: 15_000, env });
package.json:44:  "scripts": {
package.json:45:    "build": "tsc -p tsconfig.json && node scripts/postbuild.mjs",
package.json:47:    "budget": "node scripts/loc-budget.mjs",
test/surface.test.ts:12:import { tickOnce } from "../src/tick.ts";
test/surface.test.ts:66:  const a1 = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:83:  const a2 = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:93:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:103:  const a1 = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:109:  const a2 = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:126:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:134:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:151:  const actions = await tickOnce(base, "unused-entry", true, [bad, good.surface]);
test/surface.test.ts:161:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:166:  let actions = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:173:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:178:  actions = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:186:  await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:195:  const a = await tickOnce(base, "unused-entry", true, [f.surface]);
test/surface.test.ts:200:  const again = await tickOnce(base, "unused-entry", true, [f.surface]);
src/cli.ts:17:import { configuredSurfaces, tickOnce, watchLoop } from "./tick.ts";
src/cli.ts:451:  spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
src/cli.ts:881:  const surfaces = configuredSurfaces(base(v.dir));
src/cli.ts:904:  const surfaces = configuredSurfaces(base(v.dir));
src/cli.ts:905:  const actions = await tickOnce(base(v.dir), entry, wantSync(v.sync), surfaces);
```

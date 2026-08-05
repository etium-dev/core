VERDICT: revise

## design-loop-param-overbuild

Problem: `ai/DESIGN.md` requires adding `params["github.loop"]` to every GitHub-created task, but the selected loop is already carried by `SurfaceTask.loop` and recorded as `run.created.loop`; this adds new user-visible run state that the task does not require (`ai/DESIGN.md:37`, `src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`, `src/supervisor.ts:149`, `src/supervisor.ts:151`). The design itself says loop libraries own `run.params`, so adding a surface-owned loop selector there widens the loop parameter contract without a demonstrated need (`ai/DESIGN.md:37`, `src/config.ts:22`, `src/config.ts:25`).

Evidence checked: `SurfaceTask.loop` is the surface-to-core loop selector (`src/types.ts:301`, `src/types.ts:307`), `driveSurface` passes that selector directly to `createRun` (`src/tick.ts:205`, `src/tick.ts:207`), and `createRun` records the resolved provenance path in `run.created.loop` (`src/supervisor.ts:149`, `src/supervisor.ts:151`).

What resolves it: remove the `params["github.loop"]` requirement and the corresponding verification expectation, or state a concrete task requirement that needs the alias visible inside `run.params` rather than relying on `run.created.loop` (`ai/DESIGN.md:37`, `ai/DESIGN.md:53`).

## Notes

- The component-design altitude is justified because the change crosses config, GitHub routing, configure/status persistence, and the existing run creation path (`ai/DESIGN.md:5`, `src/config.ts:21`, `src/github.ts:293`, `src/tick.ts:124`, `src/tick.ts:205`).
- The alias-routing design is buildable against the current parser: GitHub commands parse one word plus optional note, lower-case the word, and the no-active-run branch currently assembles the whole directive from that parsed word and note (`ai/DESIGN.md:29`, `ai/DESIGN.md:35`, `src/github.ts:97`, `src/github.ts:101`, `src/github.ts:281`, `src/github.ts:298`).
- The verification commands are checkable by later stages because `package.json` defines `npm test` as `node --test`, and the cited focused tests already exist as extension points (`ai/DESIGN.md:43`, `ai/DESIGN.md:53`, `ai/DESIGN.md:63`, `package.json:44`, `package.json:46`, `test/tick-config.test.ts:15`, `test/ai-engineer-surface.test.ts:121`).

Command/output:
```
$ ls -la ai && sed -n '1,240p' ai/REVIEW.md && sed -n '1,260p' ai/DESIGN.md
total 32
drwxr-xr-x@  4 carlospacheco  staff   128 Aug  4 23:11 .
drwxr-xr-x@ 30 carlospacheco  staff   960 Aug  4 23:08 ..
-rw-r--r--@  1 carlospacheco  staff  9723 Aug  4 23:11 DESIGN.md
-rw-r--r--@  1 carlospacheco  staff    15 Aug  4 23:09 REPLY.md
sed: ai/REVIEW.md: No such file or directory
```

Command/output:
```
$ rg -n "ghEnv\\(" -S
src/config.ts:63:export function ghEnv(g: NonNullable<EtiumConfig["github"]>): string {
test/checks.test.ts:17:  assert.equal(ghEnv({ repo: "a/b", loop: "x/loop.ts" }), "ETIUM_GH_REPO=a/b ETIUM_GH_LOOP=x/loop.ts");
```

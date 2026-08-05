SUMMARY: Support multiple GitHub-driven loops by adding an optional named loop table beside the existing `github.loop` config, routing unqualified kickoff comments to that default and `/et <alias> ...` kickoff comments to configured named loops, then passing the chosen path through the existing `SurfaceTask.loop` -> `createRun` snapshot path (`src/config.ts:21`, `src/github.ts:97`, `src/github.ts:293`, `src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`).

## Design Style

Component design: the change crosses config, GitHub surface routing, and configure/status persistence, but the run engine already accepts a loop per surface task and snapshots it per run, so supervisor and loop execution contracts stay unchanged (`src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`, `src/supervisor.ts:121`, `src/supervisor.ts:137`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).

## Goals

- One GitHub deployment can start more than one loop library from issue comments while keeping the existing `/et <anything>` behavior for deployments with one configured loop (`src/github.ts:27`, `src/github.ts:293`, `src/github.ts:298`).
- Existing `.etium/config.json` files with `github: { repo, loop }` continue to work because `github.loop` remains the default route (`src/config.ts:13`, `src/config.ts:21`, `src/tick.ts:124`, `src/tick.ts:129`).
- Selected loops must flow through the current per-task loop path so each run records provenance and snapshots the chosen loop at creation (`src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`, `src/supervisor.ts:65`, `src/supervisor.ts:121`, `src/supervisor.ts:137`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).
- Gate decisions, mid-stage notes, lifecycle abandons, projection comments, branch creation, and labels stay loop-agnostic and keep their current behavior (`src/github.ts:104`, `src/github.ts:240`, `src/github.ts:253`, `src/github.ts:313`, `src/github.ts:320`, `src/github.ts:328`, `src/github.ts:334`, `src/github.ts:341`, `src/github.ts:367`, `src/github.ts:374`).

## Non-Goals

- Do not add a core loop registry or built-in loop names; loops remain file paths and `resolveLoop` remains the authority for existence (`src/supervisor.ts:52`, `src/supervisor.ts:54`, `src/supervisor.ts:56`).
- Do not make one run execute multiple loops; a run still has one `loop.json` and one `run.created.loop` provenance path (`src/supervisor.ts:139`, `src/supervisor.ts:146`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).
- Do not add label-, milestone-, or issue-template based auto-routing in this change; current GitHub ingress is comment-command driven (`src/github.ts:1`, `src/github.ts:97`, `src/github.ts:278`).
- Do not change scheduler wiring because `tickCommand` already reads `.etium/config.json` at runtime instead of baking loop env into cron or launchd (`src/wakeup.ts:40`, `src/wakeup.ts:46`, `src/wakeup.ts:48`).

## Options Considered

1. Single GitHub surface with named loop aliases in config. Strongest argument against it: the first word after `/et` becomes a small routing namespace, so an alias can collide with a default-loop directive word; this is acceptable because aliases are explicitly configured and unqualified comments preserve the existing default path (`src/github.ts:97`, `src/github.ts:101`, `src/github.ts:293`, `src/github.ts:298`).
2. One GitHub surface instance per loop. Strongest argument against it: every instance would poll the same repository comments and maintain its own cursor, which complicates idempotency and active-run routing that are currently repo-wide inside one surface (`src/tick.ts:163`, `src/tick.ts:178`, `src/github.ts:236`, `src/github.ts:266`, `src/github.ts:274`, `src/github.ts:280`).
3. Core-level named loop registry. Strongest argument against it: the repository deliberately treats loops as paths copied into user repos, and surface tasks already carry a concrete loop path, so a registry would add a second resolution mechanism without removing complexity (`src/supervisor.ts:52`, `src/supervisor.ts:54`, `src/types.ts:301`, `src/types.ts:307`).

## Chosen Approach

Extend `EtiumConfig.github` to `github: { repo: string; loop: string; loops?: Record<string, string> } | null`; `loop` is the default for unqualified kickoff comments, and `loops` maps lower-case aliases to loop module paths (`src/config.ts:13`, `src/config.ts:21`). Alias keys use the same word grammar that GitHub commands already parse, `[a-z][\w-]*`, so `/et ralph fix the test` can select alias `ralph` without adding a second parser (`src/github.ts:97`, `src/github.ts:101`).

Resolve loop paths in `configuredSurfaces` against the checkout root exactly like the existing single `github.loop` path; keep `ETIUM_GH_LOOP` as the default loop env for compatibility and add one structured env value, `ETIUM_GH_LOOPS`, containing JSON `{ "alias": "/abs/path/to/loop.ts" }` for named aliases (`src/tick.ts:118`, `src/tick.ts:124`, `src/tick.ts:127`, `src/tick.ts:129`). Explicit env continues to win over config because `configuredSurfaces` currently uses nullish assignment for surface env injection (`src/tick.ts:128`, `src/tick.ts:129`, `src/tick.ts:130`).

Add a small GitHub-surface helper that reads the loop table from `ETIUM_GH_LOOP` and `ETIUM_GH_LOOPS`: it validates alias names, validates that values are strings, and throws a clear `github surface:` error on malformed config so `driveSurface` reports `surface-error` without blocking run reconciliation (`src/github.ts:39`, `src/github.ts:41`, `src/tick.ts:184`, `src/tick.ts:186`, `src/tick.ts:188`). Do not validate path existence in the surface helper because `createRun` already resolves and reports `loop not found` through the existing surface-task error path (`src/supervisor.ts:54`, `src/supervisor.ts:56`, `src/tick.ts:205`, `src/tick.ts:215`, `src/tick.ts:216`).

Replace only the no-active-run kickoff branch in `github.poll`: after trust, open-issue, and duplicate-kickoff checks pass, select the loop before pushing `SurfaceTask` (`src/github.ts:279`, `src/github.ts:280`, `src/github.ts:281`, `src/github.ts:285`, `src/github.ts:287`, `src/github.ts:290`). If `cmd.word` matches a configured alias, use that loop and set `directive` to `cmd.note ?? ""`; if it does not match an alias, use `github.loop` and preserve the current directive assembly `[cmd.word, cmd.note].filter(Boolean).join(" ")` (`src/github.ts:290`, `src/github.ts:293`, `src/github.ts:295`, `src/github.ts:298`). If there is no default loop and the word is not a configured alias, create no task and fail closed; this matches the current behavior that an unconfigured loop cannot start a run successfully, without inventing a new outward error channel in `SurfacePollResult` (`src/types.ts:341`, `src/types.ts:342`, `src/types.ts:351`, `src/types.ts:353`).

Add `params["github.loop"]` to surface-created tasks with the selected alias, or `"default"` for the default route; keep existing `issue`, `directive`, deployment-default params, `surface`, and `surface.task` semantics unchanged (`src/github.ts:295`, `src/github.ts:296`, `src/github.ts:297`, `src/github.ts:298`, `src/tick.ts:205`, `src/tick.ts:208`). Do not use `loop` as a param name because loop libraries own `run.params` and existing conventions already use dotted names for namespaced configuration such as `harness.<step>` (`src/config.ts:22`, `src/config.ts:25`, `ai-engineer/README.md:26`, `ai-engineer/README.md:27`).

Preserve hand-edited `github.loops` on `etium configure` re-runs whenever GitHub remains enabled, because `writeConfig` currently preserves top-level `params` but replaces the passed `github` object (`src/config.ts:45`, `src/config.ts:49`, `src/config.ts:50`, `src/cli.ts:849`, `src/cli.ts:852`). `configure` may keep asking only for the default loop in this iteration; aliases can be edited in `.etium/config.json`, displayed by `statusLines`, and carried forward by configure, which is enough to make the feature reliable without expanding the interactive setup flow (`src/cli.ts:734`, `src/cli.ts:780`, `src/config.ts:68`, `src/config.ts:73`).

## Verification

- Add a focused config test proving legacy config still injects `ETIUM_GH_LOOP` and new `github.loops` injects resolved aliases without clobbering explicit env (`test/tick-config.test.ts:15`, `test/tick-config.test.ts:29`, `test/tick-config.test.ts:34`, `test/tick-config.test.ts:38`).
  Command/output:
  ```
  $ npm test -- --test-name-pattern=configuredSurfaces
  > @etium/core@0.17.0 test
  > node --test --test-name-pattern=configuredSurfaces
  # tests 1
  # pass 1
  # fail 0
  ```
- Add a GitHub surface test with two loop files: `/et fix wobble` uses the default loop and keeps directive `fix wobble`; `/et ralph make tests pass` uses alias `ralph`, stores directive `make tests pass`, and records `github.loop=ralph` in `run.created.params` (`test/ai-engineer-surface.test.ts:121`, `test/ai-engineer-surface.test.ts:128`, `test/ai-engineer-surface.test.ts:137`, `test/ai-engineer-surface.test.ts:139`, `test/ai-engineer-surface.test.ts:140`).
  Command/output:
  ```
  $ npm test -- --test-name-pattern="kickoff comment"
  > @etium/core@0.17.0 test
  > node --test --test-name-pattern=kickoff comment
  # tests 1
  # pass 1
  # fail 0
  ```
- Run the full regression suite because the change touches shared config and GitHub routing used by tick, configure, wakeup, and surface tests (`package.json:44`, `package.json:46`, `test/surface.test.ts:60`, `test/ai-engineer-surface.test.ts:202`, `test/clone-loop.test.ts:126`, `test/wakeup.test.ts:36`).
  Command/output:
  ```
  $ npm test
  > @etium/core@0.17.0 test
  > node --test
  # fail 0
  ```

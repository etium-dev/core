SUMMARY: Support multiple GitHub-driven loops by adding optional `github.loops` aliases beside the existing default `github.loop`, resolving both through `configuredSurfaces`, routing `/et <alias> ...` kickoff comments to the selected loop, and relying on the existing `SurfaceTask.loop` -> `createRun` -> `run.created.loop` path instead of adding any loop selector to `run.params` (`src/config.ts:21`, `src/tick.ts:124`, `src/tick.ts:129`, `src/github.ts:97`, `src/github.ts:101`, `src/github.ts:290`, `src/github.ts:293`, `src/types.ts:301`, `src/types.ts:307`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).

## Design Style

Component design: the change crosses persisted config, config-to-surface env injection, GitHub kickoff routing, and configure/status preservation, while the supervisor contract remains unchanged because surface tasks already carry a concrete loop path and run creation already snapshots and records that path (`src/config.ts:21`, `src/tick.ts:118`, `src/tick.ts:124`, `src/github.ts:290`, `src/types.ts:301`, `src/types.ts:307`, `src/supervisor.ts:121`, `src/supervisor.ts:137`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).

## Goals

- One GitHub wiring can start more than one loop from issue comments, with unqualified kickoff comments continuing to use `github.loop` as the default route (`src/config.ts:21`, `src/github.ts:282`, `src/github.ts:293`, `src/github.ts:298`).
- Existing configs shaped as `github: { repo, loop }` continue to work because `github.loop` remains present and `configuredSurfaces` already resolves it against the checkout root before injecting `ETIUM_GH_LOOP` (`src/config.ts:13`, `src/config.ts:21`, `src/tick.ts:124`, `src/tick.ts:127`, `src/tick.ts:129`).
- Alias selection must flow through `SurfaceTask.loop`, because `driveSurface` passes that field into `createRun` and `createRun` records the resolved provenance path as `run.created.loop` (`src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`, `src/supervisor.ts:149`, `src/supervisor.ts:151`, `ai/REVIEW.md:5`, `ai/REVIEW.md:7`).
- Gate decisions, freestyle gate notes, mid-stage notes, lifecycle abandons, branch creation, PR projection, and labels remain loop-agnostic because they route from active runs and existing run params rather than from the kickoff loop selector (`src/github.ts:240`, `src/github.ts:253`, `src/github.ts:309`, `src/github.ts:313`, `src/github.ts:320`, `src/github.ts:328`, `src/github.ts:341`, `src/github.ts:348`, `src/github.ts:367`, `src/github.ts:374`).

## Non-Goals

- Do not add `params["github.loop"]` or any equivalent selector to GitHub-created runs, because loop libraries own `run.params` defaults and the reviewed objection identifies that param as unnecessary surface-owned state (`src/config.ts:22`, `src/config.ts:25`, `ai/REVIEW.md:5`, `ai/REVIEW.md:9`).
- Do not add a core loop registry or built-in loop names, because loops are resolved as file paths and the surface task contract already takes a loop module path (`src/supervisor.ts:52`, `src/supervisor.ts:54`, `src/supervisor.ts:56`, `src/types.ts:301`, `src/types.ts:307`).
- Do not make a single run execute multiple loops, because a run has one `loop.json` loop entry and one `run.created.loop` provenance path (`src/supervisor.ts:139`, `src/supervisor.ts:146`, `src/supervisor.ts:149`, `src/supervisor.ts:151`).
- Do not change scheduler wiring, because scheduled wakeups intentionally run bare `etium tick` and let tick read `.etium/config.json` at runtime (`src/wakeup.ts:40`, `src/wakeup.ts:46`, `src/wakeup.ts:48`, `test/wakeup.test.ts:10`, `test/wakeup.test.ts:14`).

## Options Considered

1. Add a named alias table to the existing GitHub surface config. Strongest argument against it: the first word after `/et` becomes a small routing namespace and can collide with a default-loop directive word; this is acceptable because aliases are explicit config, command parsing already has exactly that word boundary, and deployments without aliases preserve current directive assembly (`src/github.ts:97`, `src/github.ts:101`, `src/github.ts:282`, `src/github.ts:293`, `src/github.ts:298`).
2. Create one GitHub surface instance per loop. Strongest argument against it: every instance would poll the same repo-wide comments and need coordinated cursors, while the current surface deliberately performs one repo-wide comment fetch and routes active runs by issue and PR number in one pass (`src/github.ts:236`, `src/github.ts:239`, `src/github.ts:264`, `src/github.ts:266`, `src/github.ts:274`, `src/github.ts:280`).
3. Add a core-level named loop registry. Strongest argument against it: `createRun` already treats loops as filesystem paths and `SurfaceTask.loop` already conveys the selected path, so a registry would duplicate existing resolution without simplifying run creation (`src/supervisor.ts:52`, `src/supervisor.ts:54`, `src/supervisor.ts:65`, `src/types.ts:301`, `src/types.ts:307`, `src/tick.ts:205`, `src/tick.ts:207`).
4. Pass alias identity through `run.params`. Strongest argument against it: the reviewed objection shows this is overbuilt because the selected loop is already present in `SurfaceTask.loop` and `run.created.loop`, and deployment params are documented as loop-owned defaults rather than surface routing state (`src/types.ts:301`, `src/types.ts:307`, `src/supervisor.ts:149`, `src/supervisor.ts:151`, `src/config.ts:22`, `src/config.ts:25`, `ai/REVIEW.md:5`, `ai/REVIEW.md:7`).

## Chosen Approach

Extend `EtiumConfig.github` to accept `github: { repo: string; loop: string; loops?: Record<string, string> } | null`, where `loop` remains the default route and `loops` maps configured aliases to loop module paths (`src/config.ts:13`, `src/config.ts:21`). Alias names use the same grammar already parsed from GitHub comments, lower-case `[a-z][\w-]*`, because `parseCommand` already extracts and lower-cases exactly one command word before the remaining note (`src/github.ts:97`, `src/github.ts:98`, `src/github.ts:101`).

In `configuredSurfaces`, continue resolving `github.loop` against the checkout root and injecting `ETIUM_GH_LOOP` only when `github.loop` is non-empty, then resolve each `github.loops` value against the same root and inject one new env var `ETIUM_GH_LOOPS` as JSON mapping alias to absolute loop path (`src/tick.ts:118`, `src/tick.ts:124`, `src/tick.ts:127`, `src/tick.ts:128`, `src/tick.ts:129`, `src/tick.ts:130`). Keep explicit env precedence by using the same nullish-assignment pattern for `ETIUM_GH_LOOPS` that `configuredSurfaces` already uses for `ETIUM_GH_REPO`, `ETIUM_GH_LOOP`, and `ETIUM_GH_WORKDIR` (`src/tick.ts:128`, `src/tick.ts:129`, `src/tick.ts:130`, `test/tick-config.test.ts:38`, `test/tick-config.test.ts:41`).

Add one GitHub-surface helper that reads `{ defaultLoop?: string; aliases: Map<string, string> }` from `ETIUM_GH_LOOP` and `ETIUM_GH_LOOPS`, validates alias keys against the parsed command-word grammar, validates alias values as strings, and throws `github surface: ...` on malformed JSON or invalid entries so `driveSurface` reports the existing `surface-error` action (`src/github.ts:39`, `src/github.ts:41`, `src/github.ts:97`, `src/github.ts:101`, `src/tick.ts:184`, `src/tick.ts:186`, `src/tick.ts:188`). Do not validate file existence in that helper, because `createRun` already resolves the chosen loop and reports `loop not found` through the existing surface-task error path (`src/supervisor.ts:54`, `src/supervisor.ts:56`, `src/tick.ts:205`, `src/tick.ts:215`, `src/tick.ts:216`).

Change only the no-active-run kickoff branch in `github.poll`: after command parsing, trust, no-active-run detection, stop filtering, duplicate filtering, and open-issue checks pass, select the loop route before pushing the `SurfaceTask` (`src/github.ts:278`, `src/github.ts:279`, `src/github.ts:280`, `src/github.ts:281`, `src/github.ts:285`, `src/github.ts:286`, `src/github.ts:287`, `src/github.ts:290`). If `cmd.word` matches an alias, set `SurfaceTask.loop` to that alias path and set `params.directive` to `cmd.note ?? ""`; if `cmd.word` does not match an alias, set `SurfaceTask.loop` to the default path and preserve the current directive assembly `[cmd.word, cmd.note].filter(Boolean).join(" ")` (`src/github.ts:290`, `src/github.ts:293`, `src/github.ts:295`, `src/github.ts:298`). If no default loop exists and the word is not a configured alias, emit no task for that comment and continue polling, because `SurfacePollResult` has tasks, decisions, abandons, notes, and cursor fields but no user-facing rejected-command channel (`src/types.ts:341`, `src/types.ts:342`, `src/types.ts:343`, `src/types.ts:347`, `src/types.ts:350`, `src/types.ts:353`).

Keep the GitHub-created task params limited to existing task data: deployment defaults, `issue`, and `directive`; `driveSurface` will still add `surface` and `surface.task` when creating the run (`src/github.ts:294`, `src/github.ts:295`, `src/github.ts:296`, `src/github.ts:297`, `src/github.ts:298`, `src/tick.ts:205`, `src/tick.ts:208`). The alias is intentionally not persisted in params; the selected loop path is visible in `run.created.loop`, and that is the run-level provenance field already defined for resolved loop module paths (`src/types.ts:45`, `src/types.ts:47`, `src/supervisor.ts:149`, `src/supervisor.ts:151`, `ai/REVIEW.md:5`, `ai/REVIEW.md:9`).

Preserve hand-edited `github.loops` on `etium configure` re-runs when GitHub remains enabled, because `writeConfig` preserves `id` and top-level `params` but currently replaces the provided `github` object with the newly selected repo and loop (`src/config.ts:47`, `src/config.ts:48`, `src/config.ts:49`, `src/config.ts:50`, `src/cli.ts:849`, `src/cli.ts:852`). Keep the interactive configure flow focused on the default loop for this change; aliases can be edited in `.etium/config.json`, status can display them beside the current GitHub loop line, and configure must carry them forward unless GitHub is turned off (`src/cli.ts:734`, `src/cli.ts:780`, `src/cli.ts:839`, `src/cli.ts:840`, `src/config.ts:68`, `src/config.ts:73`).

Do not route runtime alias support through `ghEnv`; tick and watch call `configuredSurfaces`, and the existing `ghEnv` helper is a repo/default-loop env formatter with a focused test for that output (`src/cli.ts:882`, `src/cli.ts:905`, `src/config.ts:63`, `src/config.ts:64`, `test/checks.test.ts:16`, `test/checks.test.ts:17`).

## Verification

- Add or extend a config test proving legacy config still injects `ETIUM_GH_LOOP`, `github.loops` injects resolved aliases through `ETIUM_GH_LOOPS`, and explicit `ETIUM_GH_LOOPS` is not clobbered by config (`test/tick-config.test.ts:15`, `test/tick-config.test.ts:29`, `test/tick-config.test.ts:34`, `test/tick-config.test.ts:35`, `test/tick-config.test.ts:38`, `test/tick-config.test.ts:41`).
  Command/output:
  ```
  $ npm test -- --test-name-pattern=configuredSurfaces
  > @etium/core@0.17.0 test
  > node --test --test-name-pattern=configuredSurfaces
  # tests 1
  # pass 1
  # fail 0
  ```
- Add or extend a GitHub surface test with two loop files: `/et fix wobble` uses the default loop and keeps directive `fix wobble`, while `/et ralph make tests pass` uses alias `ralph`, keeps directive `make tests pass`, and records the alias loop path in `run.created.loop` without adding `github.loop` to `run.created.params` (`test/ai-engineer-surface.test.ts:55`, `test/ai-engineer-surface.test.ts:99`, `test/ai-engineer-surface.test.ts:121`, `test/ai-engineer-surface.test.ts:128`, `test/ai-engineer-surface.test.ts:137`, `test/ai-engineer-surface.test.ts:139`, `test/ai-engineer-surface.test.ts:140`, `src/types.ts:45`, `src/types.ts:47`).
  Command/output:
  ```
  $ npm test -- --test-name-pattern="kickoff comment"
  > @etium/core@0.17.0 test
  > node --test --test-name-pattern=kickoff comment
  # tests 1
  # pass 1
  # fail 0
  ```
- Add a configure/status regression in the existing configure test area proving `github.loops` survives a GitHub-enabled configure re-run and disappears when `github` is written as `null` (`test/clone-loop.test.ts:126`, `test/clone-loop.test.ts:147`, `test/clone-loop.test.ts:152`, `test/clone-loop.test.ts:153`, `test/clone-loop.test.ts:159`, `test/clone-loop.test.ts:172`, `test/clone-loop.test.ts:174`, `test/clone-loop.test.ts:177`, `src/config.ts:47`, `src/config.ts:50`, `src/cli.ts:839`, `src/cli.ts:840`, `src/cli.ts:849`, `src/cli.ts:852`, `src/config.ts:68`, `src/config.ts:73`).
  Command/output:
  ```
  $ npm test -- --test-name-pattern=configure
  > @etium/core@0.17.0 test
  > node --test --test-name-pattern=configure
  # fail 0
  ```
- Run the full regression suite because config injection, GitHub surface routing, and run creation are shared by tick/watch and surface tests (`package.json:44`, `package.json:46`, `src/cli.ts:882`, `src/cli.ts:889`, `src/cli.ts:905`, `src/cli.ts:906`, `test/surface.test.ts:60`, `test/ai-engineer-surface.test.ts:121`, `test/wakeup.test.ts:10`).
  Command/output:
  ```
  $ npm test
  > @etium/core@0.17.0 test
  > node --test
  # fail 0
  ```

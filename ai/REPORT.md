SUMMARY: Implemented the built-in GitHub surface timeout plan in commit c1d1fc6 by adding a 15_000 ms timeout to helper-routed `gh()` calls and the direct `gh auth status` preflight, reporting `ETIMEDOUT` distinctly, and covering both timeout paths with fake-CLI `tickOnce` regression tests; `npm test` passed 97/97 (src/github.ts:46, src/github.ts:54, src/github.ts:58, src/github.ts:219, src/github.ts:222, src/github.ts:226, test/ai-engineer-surface.test.ts:121, test/ai-engineer-surface.test.ts:135, test/ai-engineer-surface.test.ts:147).

## Plan Step 1 - Surface Timeout Implementation

- Commit c1d1fc6 defines `GH_TIMEOUT_MS = 15_000` beside the GitHub surface constants (src/github.ts:43, src/github.ts:44, src/github.ts:45, src/github.ts:46).
- Commit c1d1fc6 adds `timeout: GH_TIMEOUT_MS` to helper-routed `gh()` calls while preserving UTF-8 output, JSON input, and repo-scoped `GH_CONFIG_DIR` (src/github.ts:49, src/github.ts:50, src/github.ts:51, src/github.ts:52, src/github.ts:53, src/github.ts:54).
- Commit c1d1fc6 checks `r.error` before `r.status`, reports helper `ETIMEDOUT` as `gh <prefix> timed out after 15000ms`, and keeps command-prefixed non-timeout and nonzero-status failures (src/github.ts:56, src/github.ts:57, src/github.ts:58, src/github.ts:59, src/github.ts:61).
- Commit c1d1fc6 adds `timeout: GH_TIMEOUT_MS` to the direct auth preflight while preserving repo-scoped `GH_CONFIG_DIR` (src/github.ts:219, src/github.ts:220, src/github.ts:221, src/github.ts:222).
- Commit c1d1fc6 reports auth preflight `ETIMEDOUT` as `gh auth status timed out after 15000ms`, keeps missing-CLI install guidance for other spawn errors, and keeps configure guidance for nonzero auth status (src/github.ts:224, src/github.ts:225, src/github.ts:226, src/github.ts:227, src/github.ts:229, src/github.ts:230).
- No `src/ghauth.ts` or projection `git push` changes were made; the only implementation file changed by commit c1d1fc6 is `src/github.ts` as shown by `git show --stat` below.

## Plan Step 2 - Regression Tests

- Commit c1d1fc6 returns `stubPath` from the existing setup helper so timeout tests can replace the same real fake CLI executable used by the GitHub surface harness (test/ai-engineer-surface.test.ts:115).
- Commit c1d1fc6 adds `slowGhStub`, which records `GH_CONFIG_DIR`, sleeps 16_000 ms for either `auth status` or `api`, returns `[]` for delayed API output, and returns `{}` for non-delayed commands (test/ai-engineer-surface.test.ts:121, test/ai-engineer-surface.test.ts:122, test/ai-engineer-surface.test.ts:123, test/ai-engineer-surface.test.ts:124, test/ai-engineer-surface.test.ts:125, test/ai-engineer-surface.test.ts:126, test/ai-engineer-surface.test.ts:127, test/ai-engineer-surface.test.ts:128, test/ai-engineer-surface.test.ts:129, test/ai-engineer-surface.test.ts:130, test/ai-engineer-surface.test.ts:131, test/ai-engineer-surface.test.ts:132).
- Commit c1d1fc6 adds the auth-preflight timeout test, replacing the fake CLI with `slowGhStub("auth")`, calling the existing `tickOnce` wrapper, and asserting `surface-error` contains `github poll: gh auth status timed out after 15000ms` (test/ai-engineer-surface.test.ts:135, test/ai-engineer-surface.test.ts:136, test/ai-engineer-surface.test.ts:137, test/ai-engineer-surface.test.ts:139, test/ai-engineer-surface.test.ts:141, test/ai-engineer-surface.test.ts:142, test/ai-engineer-surface.test.ts:143).
- Commit c1d1fc6 adds the helper-routed API timeout test, replacing the fake CLI with `slowGhStub("api")`, calling the existing `tickOnce` wrapper, and asserting `surface-error` contains the repo comments API prefix and `timed out after 15000ms` (test/ai-engineer-surface.test.ts:147, test/ai-engineer-surface.test.ts:148, test/ai-engineer-surface.test.ts:149, test/ai-engineer-surface.test.ts:151, test/ai-engineer-surface.test.ts:153, test/ai-engineer-surface.test.ts:154, test/ai-engineer-surface.test.ts:155, test/ai-engineer-surface.test.ts:156).
- The existing harness assertion that every fake CLI invocation receives the repo-scoped `GH_CONFIG_DIR` remains unchanged (test/ai-engineer-surface.test.ts:218, test/ai-engineer-surface.test.ts:219, test/ai-engineer-surface.test.ts:220, test/ai-engineer-surface.test.ts:221).

## Plan Step 3 - Verification

`node --test test/ai-engineer-surface.test.ts` red output before implementation:

```text
# Subtest: github poll reports a timed-out auth preflight
not ok 1 - github poll reports a timed-out auth preflight
  ---
  duration_ms: 16715.162875
  failureType: 'testCodeFailure'
  error: |-
    The expression evaluated to a falsy value:
    
      assert.ok(actions.some((a) =>
  ...
# Subtest: github poll reports a timed-out helper-routed api call
not ok 2 - github poll reports a timed-out helper-routed api call
  ---
  duration_ms: 16482.9335
  failureType: 'testCodeFailure'
  error: |-
    The expression evaluated to a falsy value:
    
      assert.ok(actions.some((a) =>
  ...
1..5
# tests 5
# pass 3
# fail 2
# duration_ms 43651.917917
```

`node --test test/ai-engineer-surface.test.ts` green output after implementation and post-red assertion correction:

```text
# Subtest: github poll reports a timed-out auth preflight
ok 1 - github poll reports a timed-out auth preflight
  ---
  duration_ms: 15087.213959
  ...
# Subtest: github poll reports a timed-out helper-routed api call
ok 2 - github poll reports a timed-out helper-routed api call
  ---
  duration_ms: 15424.698875
  ...
1..5
# tests 5
# pass 5
# fail 0
# duration_ms 39688.795375
```

`npm test` output:

```text
> @etium/core@0.15.5 test
> node --test

1..97
# tests 97
# suites 0
# pass 97
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40248.92125
```

`git show --stat --oneline --no-renames c1d1fc6` output:

```text
c1d1fc6 Add timeout for GitHub CLI surface calls
 src/github.ts                    | 19 +++++++++++++++++--
 test/ai-engineer-surface.test.ts | 41 +++++++++++++++++++++++++++++++++++++++-
 2 files changed, 57 insertions(+), 3 deletions(-)
```

## Deviations And Test Modifications

- Plan deviations: none.
- Test modifications after red phase: the helper-routed API timeout assertion was changed from an impossible literal `comments? timed out` substring to separate assertions for `comments?since=` and `timed out after 15000ms`, because the surface builds the repo comments path with a `since=` query before calling `gh()` (src/github.ts:280, test/ai-engineer-surface.test.ts:155, test/ai-engineer-surface.test.ts:156).

VERDICT: approve
Resolved since last review: none

## Notes

- The timeout regression tests intentionally add two real 15-second waits: `slowGhStub` delays with `16_000`, and both new tests call `tick()` through the GitHub surface (`test/ai-engineer-surface.test.ts:121`, `test/ai-engineer-surface.test.ts:127`, `test/ai-engineer-surface.test.ts:130`, `test/ai-engineer-surface.test.ts:131`, `test/ai-engineer-surface.test.ts:139`, `test/ai-engineer-surface.test.ts:151`).
- The implementation report's disclosed post-red assertion correction is sound: the surface constructs the comments path with a `since=` query, and the final test asserts that prefix plus the timeout text separately (`ai/REPORT.md:100`, `ai/REPORT.md:101`, `src/github.ts:280`, `test/ai-engineer-surface.test.ts:153`, `test/ai-engineer-surface.test.ts:155`, `test/ai-engineer-surface.test.ts:156`).

`git show --stat --oneline --no-renames c1d1fc6`

```text
c1d1fc6 Add timeout for GitHub CLI surface calls
 src/github.ts                    | 19 +++++++++++++++++--
 test/ai-engineer-surface.test.ts | 41 +++++++++++++++++++++++++++++++++++++++-
 2 files changed, 57 insertions(+), 3 deletions(-)
```

`git diff --name-status 9a96eda..HEAD`

```text
A	ai/REPORT.md
M	src/github.ts
M	test/ai-engineer-surface.test.ts
```

`node --test test/ai-engineer-surface.test.ts`

```text
TAP version 13
# Subtest: github poll reports a timed-out auth preflight
ok 1 - github poll reports a timed-out auth preflight
  ---
  duration_ms: 15089.617375
  type: 'test'
  ...
# Subtest: github poll reports a timed-out helper-routed api call
ok 2 - github poll reports a timed-out helper-routed api call
  ---
  duration_ms: 15408.0235
  type: 'test'
  ...
# Subtest: kickoff comment → worktree run with directive; read-only commenter ignored; projection pushes branch, opens draft PR, upserts status, labels
ok 3 - kickoff comment → worktree run with directive; read-only commenter ignored; projection pushes branch, opens draft PR, upserts status, labels
  ---
  duration_ms: 2198.959083
  type: 'test'
  ...
# Subtest: issue close abandons the active run (lifecycle sweep fetches the issue directly)
ok 4 - issue close abandons the active run (lifecycle sweep fetches the issue directly)
  ---
  duration_ms: 1871.044208
  type: 'test'
  ...
# Subtest: exact /et word decides; freestyle → consider with the full text; read-only ignored; /et stop abandons; a new /et is attempt \#1
ok 5 - exact /et word decides; freestyle → consider with the full text; read-only ignored; /et stop abandons; a new /et is attempt \#1
  ---
  duration_ms: 5656.15325
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40371.901708
```

`npm test`

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
# duration_ms 40710.950291
```

# Release Confidence

Status: agreed strategy, 2026-08-03 — **not yet implemented**. This is the
working plan for tests and release guards giving high confidence that no
release of `@etium/core` breaks existing clients or ships bugs. Execute in
the phase order at the bottom; strike items as they land.

Baseline at time of writing: one Ubuntu CI job on Node 22 running
build + 62 tests + LOC budgets. Known gaps: the strict typecheck
(`tsconfig.check.json`) is not in CI; nothing ever tests the **tarball**
(every packaging bug to date — e.g. the 0.2.0 version-constant drift —
lived in the repo-vs-package gap); no OS/Node matrix; no compatibility
corpus; releases are a human running `npm publish` with only local gates.

Organizing principle: **test the artifact, not the repo.** Every
release-gating check runs against the packed tarball installed into a
pristine environment — the thing users actually get. The repo-level suite
is the fast inner loop, nothing more.

---

## 1. The contract — what "don't break existing clients" means

Each surface below is a promise someone already relies on; each maps to a
guard class defined later.

| # | Surface | Who breaks if it drifts | Guard |
|---|---|---|---|
| C1 | Ledger schema + on-disk layout | Every existing run directory — runs park for days, so users upgrade etium **mid-run** | §3 corpus |
| C2 | Replay semantics + config digest | A digest algorithm change spuriously `DIVERGENCE`s every in-flight run on resume | §3 digest goldens |
| C3 | Loop API (`run.step/gate/effect/task/params/t`, occurrence rules, note injection) | Every user-authored loop | §4 snapshots + behavior suite |
| C4 | CLI grammar, exit codes, and the exact output strings the published docs grep (`outcome: parked`, the `gates` format) | Scripts, cron lines, agents following AGENT_INSTALL | §5 docs-as-tests |
| C5 | Adapter/Surface interfaces + env config (`ETIUM_GH_*`) | Custom adapters, custom surfaces, deployed cron lines | §4 snapshots, §6 contract fixtures |
| C6 | The tarball: files present, bin wired, clone-loop payload, zero runtime deps, Node floor | Every `npm install` | §2 Gate 1 |

---

## 2. The pipeline — five gates between a commit and `latest`

**Gate 0 — PR CI** (minutes, every push).
- [ ] Strict typecheck: `tsc -p tsconfig.check.json` (src + tests + ai-engineer).
- [ ] Full suite with `--experimental-test-coverage`; per-area thresholds (core highest).
- [ ] LOC budgets (exists).
- [ ] Zero-runtime-deps assertion: `npm ls --omit=dev` is empty. Emptiness is a feature; guard it.
- [ ] Matrix: {ubuntu, macos} × {Node 22.18 **floor pin**, 22 latest, 24 latest}. The floor pin matters: type-stripping is exactly the thing that silently works only on newer Node.

**Gate 1 — Artifact journey** (release candidates).
- [ ] `npm pack`; install the tarball globally in a clean container.
- [ ] Execute the published promises verbatim: QUICKSTART offline hello-world; `clone-loop` into a fresh git repo; the AGENT_INSTALL acceptance script with its literal PASS criteria; the ai-engineer dry run to `run DONE`; `tick --surface github` against the stub `gh`.
- This gate catches the repo-vs-package bug class (version drift, missing files, `.ts`-in-node_modules).

**Gate 2 — Compatibility gates** (the existing-clients heart). All diffs are against the **previously published version downloaded from npm**, not against git.
- [ ] **Run-corpus replay**: a committed corpus of golden run directories — one frozen per released version, in every interesting state (parked at an option gate, mid-converge, completed, abandoned, torn final line, worktree metadata). The candidate must fold every one without error and resume the parked ones to the same outcome with **zero divergence**. Plus the live variant: create a run with `etium@prev` from npm, finish it with the candidate — the upgrade-mid-run guarantee.
- [ ] **Digest-stability goldens**: fixed `StepOptions` → pinned exact digest hashes. A change fails with a message that it will diverge every in-flight run in the world; requires an explicit migration decision, never just a version bump.
- [ ] **Contract diffs**: public `.d.ts` API report, `etium --help` grammar, `events.schema.json`, tarball file list — each diffed against the previous release. Removal/mutation demands a matching semver-major (additions: minor), enforced mechanically; overridable only by a committed, human-written exception file naming the break.

**Gate 3 — Canary.**
- [ ] CI publishes to the **`next` dist-tag** via npm **trusted publishing** (GitHub Actions OIDC, `--provenance`). This also dissolves the passkey friction legitimately: no token, no OTP, and publishing happens only from the release workflow.
- [ ] `prepublishOnly` refuses local publishes (checks for the CI env) so the pipeline is the only path.
- [ ] Post-publish job installs `@etium/core@next` **from the registry** and reruns the Gate-1 journey against it.

**Gate 4 — Promotion + sentinel.**
- [ ] `npm dist-tag add @etium/core@X latest` — metadata-only, so `latest` never points at an artifact that hasn't survived every gate *as installed from the registry*. Rollback = move the tag back + `npm deprecate` the bad version.
- [ ] Daily scheduled **sentinel**: install `latest` from the registry, run the journey. Registry-side rot or a bad promote surfaces within a day, not via a user issue.

---

## 3. Invariant torture — DESIGN §2's promises as adversarial suites

- [ ] **Crash-only kill-matrix**: a test-mode hook SIGKILLs the supervisor deterministically after *each* ledger append (every event boundary enumerated — no sleeps, no timing). Assert: `tick` recovery converges to the identical final state; completed steps never re-execute; the ledger diff vs. an uncrashed run is only the interruption records. Same matrix for kill-during-`createRun` (worktree cleanup) and kill-mid-mailbox-ingestion (a decision is consumed exactly once or still pending — never lost, never doubled).
- [ ] **Single-writer storm**: N concurrent `tickOnce` + `approve` + `resume` racing on one base; exactly one writer wins each attach; `seq` gapless-monotonic; no interleaved appends. Include a pid-reuse simulation for the `isLockLive` edge.
- [ ] **Replay determinism as a property**: for randomly generated loops (steps/gates/effects nested in `for` loops and `Promise.all`), attach K times with crashes interleaved → folded state identical every time; occurrence assignment stable. Generalizes `fold-property` from event streams to whole executions.
- [ ] **Fail-closed decision fuzzing**: malformed / duplicate / undeclared-option / stale-gate decision files in the mailbox — nothing ever decides a gate except an exact, declared, open match.
- [ ] **Redaction property**: any declared secret value planted in harness stdout/stderr/grade output never appears in **any** file under the run dir post-step (sweep the whole tree, not just raw).
- [ ] **Torn-line fuzzing**: random truncation at every byte offset of the final ledger line, not just newline-boundary cases.

---

## 4. Interface snapshots — drift becomes a diff you must sign

Three generated, committed snapshot files, regenerated by script and
asserted byte-identical in CI. Changing one requires committing the new
snapshot — every contract change becomes visible in review and greppable in
history. (This is the dependency-free api-extractor.)

- [ ] Public type surface (from `index.d.ts`).
- [ ] CLI help/grammar plus a per-command exit-code table.
- [ ] Fold output (`state.json`) golden for a canonical ledger.

---

## 5. Docs as tests — the tutorials can never lie

- [ ] A doc-runner executes every fenced command block in QUICKSTART, WRITING_LOOPS, TUTORIAL, and AGENT_INSTALL during Gate 1. Blocks requiring a real model or real GitHub are tagged for skip and get stub equivalents.
- [ ] This freezes the CLI output strings the docs quote — the `etium gates` format is load-bearing for the agent path and is tested as such.

---

## 6. The github surface's special problem

Stub-`gh` tests prove our logic against our **model** of `gh`; nothing
proves the model.

- [ ] **Recorded-fixture contract suite**: capture real `gh api` responses once (harness-fixture pattern, ADR-005); assert the stub's shapes match the recordings.
- [ ] **Monthly drift job**: re-capture live responses, diff against fixtures — GitHub API drift alerts before users hit it.
- [ ] **Error-path matrix**: rate-limited, 404 mid-poll, network flake — tick isolation holds; cursors never advance past unprocessed work.

---

## 7. Process guards

- [ ] `RELEASING.md`: the checklist the release workflow enforces — changelog entry per release; the §2 semver gate; DESIGN §2's standing rule ("changes to core preserve the invariants or amend the list in the same change") asked explicitly in the PR template.
- [ ] LOC budgets continue as-is (already enforced).
- Deliberately deferred: mutation testing (Stryker) — core-only candidate for later; fights the zero-deps ethos for modest gain at this size. Windows support: undeclared and untested (crash-only leans on POSIX signals, process groups, symlinks); either declare POSIX-only in `package.json`/README or add a Windows matrix leg — decide when someone asks.

---

## Sequencing

1. **Gate 0 hardening + Gate 1 artifact journey** — highest leverage; catches the bug classes actually shipped to date.
2. **Compat corpus + digest goldens + interface snapshots** (Gate 2, §4) — the existing-clients guarantee; seed the corpus retroactively from the 0.1.0 / 0.2.1 / 0.3.0 tarballs already on npm.
3. **Trusted-publishing release workflow + canary/promote + sentinel** (Gates 3–4).
4. **Invariant torture suites** (§3) — the largest test-code investment; converts the design's claims into enforced properties.
5. **Docs-runner + gh contract fixtures** (§5–6).

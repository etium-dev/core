Stage: plan (Plan Builder).

Produce the implementation plan. If `ai/DIAGNOSIS.md` or `ai/DESIGN.md`
exist they are your ground truth. Write `ai/PLAN.md`:

1. **Steps** — numbered, each naming the files it touches.
2. **Test plan first** — the tests to write before implementing, and the
   red-phase expectation for each.
3. **Verification** — the command that proves completion.
4. **Risks** — what could go wrong and the rollback.

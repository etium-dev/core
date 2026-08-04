Scrutiny for `ai/PLAN.md`:

- The implementor executes these steps verbatim: any step that requires
  invention, guessing, or a decision not recorded in the plan is an
  objection.
- Check the named files exist and are the right ones; check the steps
  honor `ai/DESIGN.md` / `ai/DIAGNOSIS.md` where they exist.
- Tests-first must be genuine: each planned test must plausibly start
  red for the stated reason, and together they must cover the task —
  name what slips through.
- The verify command must prove the task itself, not a proxy.
- Every named risk needs a workable rollback.

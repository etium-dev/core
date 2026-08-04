Scrutiny for `ai/PLAN.md`:

- The implementor executes these steps verbatim: any step that requires
  invention, guessing, or a decision not recorded in the plan is an
  objection. Expanding a stated rule into its cases is not invention —
  demanding the full expansion written out is an objection against the
  review.
- A step written as a data dump is an objection: enumerations belong as
  a rule plus a few anchors, design-settled interfaces as citations.
  Flag any detail whose removal would change nothing the implementor
  builds.
- Check the named files exist and are the right ones; check the steps
  honor `ai/DESIGN.md` / `ai/DIAGNOSIS.md` where they exist.
- The plan may add detail, never components: any mechanism, module, or
  state machine that `ai/DESIGN.md` does not call for is an objection —
  planning is not the stage where architecture appears.
- Tests-first must be genuine: each planned test must plausibly start
  red for the stated reason, and together they must cover the task —
  name what slips through.
- The verify command must prove the task itself, not a proxy.
- Every named risk needs a workable rollback.
- Be complete but succinct in your output.

Scrutiny for `ai/PLAN.md`:

- Assess the plan from the view that a coding agent will implement it.
  Every detail need not be spelled out - coding agents are smart. But
  ambiguity that would force the agent to make ***important*** decisions
  about architecture, APIs, etc. means the plan should be more detailed.
  Small changes to APIs, step changes in architecture, are ok.
- Tests-first must be genuine: each planned test must plausibly start
  red for the stated reason, and together they must cover the task —
  name what slips through. The tests should not use mocks, and should
  test the behaviors faithfully.
- Every named risk needs a workable rollback.
- Be complete but succinct in your output.

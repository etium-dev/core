Scrutiny for `ai/DESIGN.md`:

- Review at the declared style's altitude: a mini-design owes brevity,
  not architecture. Demanding heavier machinery or more specification
  than the declared style requires is an objection against the review,
  not the design. A design whose style is too light for its task earns
  exactly one blocker — the style, with why — not piecemeal objections
  at the heavier altitude.
- Overbuilding is a defect at every style: any component, abstraction,
  or state the task does not require is an objection, whatever its
  quality.
- The planner and implementor will rely on this document alone: probe it
  for ambiguity — any point where two reasonable implementors would
  build different things is an objection, judged at the declared
  style's altitude.
- Check every cited integration point (`file:line`) against the actual
  code; a design that meets the codebase where it isn't is unbuildable.
- Above the mini style, the options must be real: the argument against
  each stated at full strength. A strawman alternative is an objection.
- Goals and non-goals must match the task; flag scope the task never
  asked for.
- The verification section must be checkable by later stages as written.
- Be complete but succinct in your output.

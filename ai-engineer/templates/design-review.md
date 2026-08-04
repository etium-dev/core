Scrutiny for `ai/DESIGN.md`:

- The planner and implementor will rely on this document alone: probe it
  for ambiguity — any point where two reasonable implementors would
  build different things is an objection.
- Check every cited integration point (`file:line`) against the actual
  code; a design that meets the codebase where it isn't is unbuildable.
- The options must be real: the argument against each stated at full
  strength. A strawman alternative is an objection.
- Goals and non-goals must match the task; flag scope the task never
  asked for.
- The verification section must be checkable by later stages as written.
- Be complete but succinct in your output.

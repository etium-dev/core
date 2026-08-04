Act as the plan builder. `ai/DIAGNOSIS.md` and `ai/DESIGN.md`, when
present, are ground truth.

Write `ai/PLAN.md` covering: the tests to write first and why each
starts red; the numbered steps, each naming the files it touches — the
implementor executes these verbatim, so make them unambiguous and
complete; the command that proves completion; and the risks with their
rollbacks. Be complete but succinct in your output.

When proposing tests: do not use mocks anywhere in the test except in the
most trivial of cases. Instead use test helpers provided by components used
for example test databases, or carefully design fakes that do not inject
expected behavior but behave as a small, in-memory version of the real thing.

Write the implementation plan in a series of stages that will each be
a coherent unit that holds on its own, can be tested and verified before
the next stage.

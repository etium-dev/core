Act as a software engineer building a plan that a coding agent can implement
faithfully. `ai/DESIGN.md` is ground truth; so is `ai/DIAGNOSIS.md` when present.

The goals of the plan:

<goals>
<goal>A smart coding agent can implement the plan without having to make
important decisions about the solution's shape. Do not specify every little
detail. Just make it clear enough for the agent to build.
</goal>
<goal>The plan specifies the ordered stages that the agent should implement.
Each stage is a coherent unit of work that stands on its own,
can be tested and verified before the next stage.
</goal>
<goal>The plan has a testing plan within it: what behaviors to test and
if needed, how to implement the tests to make sure they are testing
true behavior not made up artifacts.
</goal>
</goals>

<rules>
  <rule>Keep it succinct. A human should be able to read the plan and
  not be drowned in details.</rule>
  <rule>Keep a high bar for simplicity, elegance and excellent code.</rule>
  <rule>When proposing tests: do not use mocks anywhere in the test except in the
most trivial of cases. Instead use test helpers provided by components used
for example test databases, or carefully design fakes that do not inject
expected behavior but behave as a small, in-memory version of the real thing.
</rule>
</rules>


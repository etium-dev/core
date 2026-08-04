Role: implementor — execute `ai/PLAN.md` exactly.

Red first: write the planned tests, watch them fail, then implement
until they pass. Commit code in logical units. Write `ai/REPORT.md` in
exactly this shape:

    # Report: <task title>

    ## Changes
    - step <n>: <what landed> (<commit>)
    <one line per plan step>

    ## Evidence
    $ <the verification command>
    <its decisive output lines, at most 10>

    ## Disclosures
    - <deviation from the plan, or a test modified after red> — <why>
    <"none" when clean; never omit this section>

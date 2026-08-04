Role: intake analyst — investigate the repository until the task is
understood, then recommend a route.

Write `ai/INTAKE.md` in exactly this shape:

    # Intake: <task title>

    ## Task
    <the ask in your words — one or two sentences>

    ## Findings
    - <fact> (`path/file.ts:12`)
    <at most 8 bullets, one line each: only facts that change the route
    or the eventual plan — relevant files, existing behavior, prior art>

    ## Route
    <debug | design | plan> — <one sentence why>

Routes: `debug` = root cause unknown; `design` = architecture unclear;
`plan` = the path is clear. The human chooses; you recommend.

Task:
{{task}}

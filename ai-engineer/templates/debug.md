Role: investigator — establish the root cause by reproducing it.

Reproduce before theorizing. Write `ai/DIAGNOSIS.md` in exactly this
shape:

    # Diagnosis: <the cause, one line>

    ## Reproduction
    $ <exact command>
    <the decisive output lines, at most 10>

    ## Cause
    <the mechanism — at most 3 sentences, each citing file:line>

    ## Ruled out
    - <competing explanation> — <the fact that kills it>
    <at most 3>

    ## Fix sketch
    <the smallest correct fix and its main risk — at most 3 lines>

If you cannot reproduce: say so under Reproduction, list what you tried
(at most 5 lines), and stop — no speculative Cause.

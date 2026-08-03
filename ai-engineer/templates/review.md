Stage: review of {{stage}} (independent reviewer).

Adversarially review the {{stage}} stage's output: its `ai/` document and,
for implement, the diff and test evidence. Your job is to find what is
wrong, unproven, or missing — not to be agreeable. Write `ai/REVIEW.md`:

- First line, exactly: `VERDICT: approve` or `VERDICT: revise`.
- Then, for each objection: a stable key (`{{stage}}-<slug>`), the problem,
  the evidence, and what would resolve it. Keep keys identical across rounds
  so unresolved objections are trackable.

Approve only when the stage's claims are supported by evidence you checked
yourself. An unproven claim is an objection, not a footnote.

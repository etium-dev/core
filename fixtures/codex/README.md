`synthetic.jsonl` is hand-written against the provisional parser in
`src/adapters.ts` — honest labeling: it validates plumbing, not the real
`codex exec --json` schema. Replace-alongside with real captures from
`scripts/capture-fixtures.sh`, then harden the parser and delete this note.

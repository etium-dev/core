VERDICT: approve

## Notes

- The timeout verification can pass by timing out the auth preflight before reaching helper-routed API calls, because `poll` runs `gh auth status` first (`src/github.ts:209`, `src/github.ts:212`), while normal API reads and writes go through `gh()` via `api`, `post`, and `del` (`src/github.ts:48`, `src/github.ts:63`, `src/github.ts:64`, `src/github.ts:65`).
- The design's recorded `rg --files ai` output is stale: it records only `ai/REPLY.md` (`ai/DESIGN.md:37`, `ai/DESIGN.md:39`, `ai/DESIGN.md:40`, `ai/DESIGN.md:41`), but the current output is:

```text
ai/DESIGN.md
ai/REPLY.md
```

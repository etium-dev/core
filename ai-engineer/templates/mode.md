Act as the interpreter for run modes. A mode is a named bundle of
settings (models, harnesses, rounds) the operator may pick in plain
language. Decide which mode — if any — the operator's words ask for.

Message: {{message}}
Modes:
{{modes}}

Write `ai/REPLY.md` with a first line of exactly one of:

- `MODE: <name>` — the message clearly asks for that mode. Match on
  intent, not just the literal name: "use the careful one", "run it
  cheap", "fast mode" all name a mode if one fits. Description matches
  count.
- `MODE: none` — the message does not ask for a mode at all (it is only a
  task or an instruction). This is the common case; the run then uses its
  default settings. Do not invent a mode the operator did not ask for.
- `MODE: unclear` — the operator plainly wants a mode but none fits, or
  two fit equally. Follow it with one short line naming the choices. The
  operator will pick or rephrase; never guess when a mode was requested.

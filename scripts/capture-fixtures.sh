#!/usr/bin/env bash
# Capture raw harness streams as fixtures. Run on a machine with the harnesses
# installed and authenticated. Commit the outputs under fixtures/.
#
# Fixtures serve two purposes (DECISIONS ADR-005):
#   1. Harden the codex parser (currently provisional).
#   2. Pressure-test schema neutrality with claude/pi captures BEFORE those
#      adapters exist.
#
# Pin the exact flags you used in fixtures/<harness>/FLAGS.txt — parsers are
# validated against a pinned invocation, not "whatever the CLI does today".
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
PROMPT=${1:-"Create a file hello.txt containing the word hello, then read it back."}
mkdir -p fixtures/codex fixtures/claude fixtures/pi

echo "== codex =="
if command -v codex >/dev/null; then
  ( cd "$(mktemp -d)" && codex exec --json "$PROMPT" ) | tee "fixtures/codex/$TS.jsonl" || true
  codex --version > fixtures/codex/FLAGS.txt 2>&1 || true
  echo "codex exec --json <prompt>" >> fixtures/codex/FLAGS.txt
else echo "codex not installed; skipping"; fi

echo "== claude code =="
if command -v claude >/dev/null; then
  ( cd "$(mktemp -d)" && claude -p "$PROMPT" --output-format stream-json --verbose ) | tee "fixtures/claude/$TS.jsonl" || true
  claude --version > fixtures/claude/FLAGS.txt 2>&1 || true
  echo "claude -p <prompt> --output-format stream-json --verbose" >> fixtures/claude/FLAGS.txt
else echo "claude not installed; skipping"; fi

echo "== pi =="
if command -v pi >/dev/null; then
  # Check `pi --help` for the current headless JSON mode; adjust and PIN here.
  ( cd "$(mktemp -d)" && pi --mode json -p "$PROMPT" ) | tee "fixtures/pi/$TS.jsonl" || true
  pi --version > fixtures/pi/FLAGS.txt 2>&1 || true
  echo "pi --mode json -p <prompt>   # verify against pi --help and pin" >> fixtures/pi/FLAGS.txt
else echo "pi not installed; skipping"; fi

echo "Done. Review for secrets before committing (etium redacts at runtime; tee here does not)."

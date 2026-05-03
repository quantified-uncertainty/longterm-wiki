#!/usr/bin/env bash
#
# PostToolUse hook for Edit — caps per-file edit churn at N edits/session.
#
# Long Claude Code sessions repeatedly chase test/validator failures by
# editing the same file 10-30 times. Pathology analysis: 13 of 19 long
# sessions had >=10 edits to a single file (worst: 28 edits to one file).
# The Reflexion literature names this degeneration-of-thought: once the
# model is confident in a wrong solution, more iterations entrench it.
# Cursor's published guidance is "revert and refine over iterate."
#
# Mechanism:
#   1. Track Edit count per absolute file path in a per-slot state file
#      (.claude/.edit-counts.json).
#   2. When count first reaches the cap (default 5), exit 2 and emit a
#      <system-reminder> requiring revert + replan + fresh subagent.
#   3. Every subsequent Edit to the same file also exits 2 (the count
#      stays over cap), so further iteration is consistently surfaced
#      as a violation. PostToolUse cannot un-do the edit on disk; the
#      reminder explicitly tells the agent to git-checkout the file.
#
# State file lifecycle:
#   - Created lazily on the first Edit in the session.
#   - Cleaned at SessionStart (mirrors .claude/wip-checklist.md lifecycle —
#     see .claude/hooks/session-start.sh § "Clear stale checklist").
#   - Per-slot: each slot has its own .claude/ directory, so per-file
#     counts never leak between concurrent slots.
#
# Override knobs:
#   CLAUDE_EDIT_CHURN_CAP=N      # change the per-file cap (default 5)
#   CLAUDE_EDIT_CHURN_DISABLE=1  # bypass the hook entirely (testing/recovery)
#
# Fail-open: any internal error (missing jq, malformed input, write
# failure) exits 0 with a stderr warning. The hook must never brick a
# session — the cap is a productivity guardrail, not a security boundary.
#
# See QUA-1070.

set -uo pipefail

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
COUNTS_FILE="$REPO_ROOT/.claude/.edit-counts.json"
CAP="${CLAUDE_EDIT_CHURN_CAP:-5}"

if [ -n "${CLAUDE_EDIT_CHURN_DISABLE:-}" ]; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "cap-edit-churn: jq not found — hook disabled" >&2
  exit 0
fi

INPUT_JSON=$(cat 2>/dev/null || true)
if [ -z "$INPUT_JSON" ]; then
  exit 0
fi

# Single jq call extracts both fields. Defaults keep the read non-fatal
# when the upstream payload changes shape (Claude Code occasionally
# adds/removes fields).
read -r TOOL_NAME FILE_PATH < <(echo "$INPUT_JSON" \
  | jq -r '[(.tool_name // ""), (.tool_input.file_path // "")] | @tsv' 2>/dev/null \
  || echo $'\t')

if [ "$TOOL_NAME" != "Edit" ]; then
  exit 0
fi
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Atomic increment: read existing counts, bump, write to temp, mv into
# place. mv on the same filesystem is atomic. Concurrent Edits to the
# same file can race in the read-modify-write window; under-counting by
# 1-2 is acceptable for a soft heuristic.
mkdir -p "$(dirname "$COUNTS_FILE")"
EXISTING=$(cat "$COUNTS_FILE" 2>/dev/null || echo '{}')
if ! echo "$EXISTING" | jq empty 2>/dev/null; then
  # Corrupted state file — start over rather than failing the hook.
  EXISTING='{}'
fi

NEW=$(echo "$EXISTING" | jq --arg f "$FILE_PATH" '.[$f] = (.[$f] // 0) + 1' 2>/dev/null)
if [ -z "$NEW" ]; then
  echo "cap-edit-churn: jq update failed — hook disabled for this turn" >&2
  exit 0
fi

TMP="$COUNTS_FILE.tmp.$$"
if ! { echo "$NEW" > "$TMP" && mv "$TMP" "$COUNTS_FILE"; }; then
  rm -f "$TMP"
  echo "cap-edit-churn: could not write $COUNTS_FILE — hook disabled for this turn" >&2
  exit 0
fi

COUNT=$(echo "$NEW" | jq -r --arg f "$FILE_PATH" '.[$f]')
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  exit 0
fi

if [ "$COUNT" -lt "$CAP" ]; then
  exit 0
fi

# At or over cap — emit revert/replan reminder. Exit 2 surfaces stderr
# to the agent as feedback for the next turn.
cat >&2 <<EOF
BLOCKED: edit-churn cap reached for "$FILE_PATH" (edit #$COUNT, cap is $CAP).

Industry research (Reflexion, Cursor "revert and refine over iterate")
shows that 5+ edits to the same file in one session typically entrench
a wrong solution rather than converge on the right one. Stop iterating.

Required actions, in order:

  1. Revert ALL session edits to this file:
       git checkout -- "$FILE_PATH"
     (Do not "fix" the in-flight edit — revert it. The accumulated
     diff is the symptom, not the bug.)

  2. Add a 3-line note to .claude/wip-checklist.md documenting:
     - what the validator/test actually wants (paste its output)
     - what was tried (the approach class, not each individual edit)
     - the suspected wrong assumption you are now resetting on

  3. Either:
     a) Dispatch a fresh subagent with the note as the brief —
          ./ws dispatch <slot> "<task + revert note + validator output>"
        The fresh agent reads the note as input, not your chat history.
     b) Escalate to the user — describe the symptom + the wrong
        assumption + what the next approach class would be.

Further Edit calls on this file in this session will continue to
trigger this block. The cap is a deliberate stopping point.

Bypass for one turn (NOT recommended — it's the same loop):
  CLAUDE_EDIT_CHURN_DISABLE=1

See QUA-1070 for the pathology data and research behind this rule.
EOF

exit 2

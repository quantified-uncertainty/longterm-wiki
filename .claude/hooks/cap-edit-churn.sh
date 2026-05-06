#!/usr/bin/env bash
#
# PostToolUse hook for Edit/Write/NotebookEdit — caps per-file edit churn.
#
# State: .claude/.edit-counts.json (gitignored, cleaned at SessionStart).
# Knobs: CLAUDE_EDIT_CHURN_CAP=N (positive int, default 5),
#        CLAUDE_EDIT_CHURN_DISABLE=1 (bypass).
# Fail-open: any internal error exits 0 with a stderr warning.
# Security: file_path is sanitized (control chars + angle brackets stripped)
#   before emission, since stderr becomes agent-visible feedback.
# See QUA-1070 and .claude/rules/implementation-quality.md § "Edit-Churn".

set -uo pipefail

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
COUNTS_FILE="$REPO_ROOT/.claude/.edit-counts.json"
CAP="${CLAUDE_EDIT_CHURN_CAP:-5}"

if [ -n "${CLAUDE_EDIT_CHURN_DISABLE:-}" ]; then
  exit 0
fi

# Without this guard, CAP=abc/0/-1 falls through to "block always" because
# `[ -lt ]` errors and the comparison evaluates as false.
if ! [[ "$CAP" =~ ^[1-9][0-9]*$ ]]; then
  echo "cap-edit-churn: CLAUDE_EDIT_CHURN_CAP must be a positive integer (got '$CAP') — hook disabled" >&2
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "cap-edit-churn: jq not found — hook disabled" >&2
  exit 0
fi

INPUT_JSON=$(cat 2>/dev/null || true)
[ -n "$INPUT_JSON" ] || exit 0

# NotebookEdit uses .tool_input.notebook_path; Edit/Write use .tool_input.file_path.
read -r TOOL_NAME FILE_PATH < <(jq -r \
  '[(.tool_name // ""), (.tool_input.file_path // .tool_input.notebook_path // "")] | @tsv' \
  <<<"$INPUT_JSON" 2>/dev/null || echo $'\t')

case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

[ -n "$FILE_PATH" ] || exit 0

mkdir -p "$(dirname "$COUNTS_FILE")"

# Trap cleans up the .tmp.<pid> file if the hook is killed (5s timeout)
# between write and mv.
TMP="$COUNTS_FILE.tmp.$$"
trap 'rm -f "$TMP"' EXIT

EXISTING=$(cat "$COUNTS_FILE" 2>/dev/null || echo '{}')
if ! jq empty <<<"$EXISTING" 2>/dev/null; then
  EXISTING='{}'
fi

NEW=$(jq --arg f "$FILE_PATH" '.[$f] = (.[$f] // 0) + 1' <<<"$EXISTING" 2>/dev/null)
if [ -z "$NEW" ]; then
  echo "cap-edit-churn: jq update failed — hook disabled for this turn" >&2
  exit 0
fi

COUNT=$(jq -r --arg f "$FILE_PATH" '.[$f]' <<<"$NEW" 2>/dev/null)
# Guard against jq failure — without this an empty COUNT errors `[ -le ]` and
# short-circuits past the silent `exit 0`, falsely emitting BLOCKED.
[[ "$COUNT" =~ ^[0-9]+$ ]] || exit 0

if ! { printf '%s\n' "$NEW" > "$TMP" && mv "$TMP" "$COUNTS_FILE"; }; then
  echo "cap-edit-churn: could not write $COUNTS_FILE — hook disabled for this turn" >&2
  exit 0
fi

# CAP=5 → edits 1-5 silent, edit 6 blocks. Matches the rule wording
# "after 5 edits...STOP" and is the more forgiving interpretation than
# blocking on the Nth edit itself.
[ "$COUNT" -le "$CAP" ] && exit 0

SAFE_PATH=$(printf '%s' "$FILE_PATH" | tr -d '\000-\037<>`$\\')

cat >&2 <<EOF
BLOCKED: edit-churn cap reached for "$SAFE_PATH" (edit #$COUNT, cap is $CAP).

Industry research (Reflexion, Cursor "revert and refine over iterate")
shows that 5+ edits to the same file in one session typically entrench
a wrong solution rather than converge on the right one. Stop iterating.

Required actions, in order:

  1. Revert ALL session edits to this file:
       git checkout -- "$SAFE_PATH"
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

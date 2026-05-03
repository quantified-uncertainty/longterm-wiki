#!/usr/bin/env bash
#
# PostToolUse hook for Edit/Write/NotebookEdit — caps per-file churn.
#
# Long Claude Code sessions repeatedly chase test/validator failures by
# editing the same file 10-30 times. Pathology analysis: 13 of 19 long
# sessions had >=10 edits to a single file (worst: 28 edits to one file).
# The Reflexion literature names this degeneration-of-thought: once the
# model is confident in a wrong solution, more iterations entrench it.
# Cursor's published guidance is "revert and refine over iterate."
#
# Mechanism:
#   1. Track per-file mutation count in a per-slot state file
#      (.claude/.edit-counts.json). Edit, Write, and NotebookEdit all
#      count — a stuck agent that switches from Edit to Write to bypass
#      the cap should still trip it.
#   2. With default CAP=5, edits 1-5 are silent and edit 6 triggers
#      exit 2 with a system-reminder requiring revert + replan + fresh
#      subagent. Every subsequent edit on the same file also blocks
#      (count stays over cap), so further iteration is consistently
#      surfaced as a violation. PostToolUse cannot un-do the edit on
#      disk; the reminder tells the agent to git-checkout the file.
#   3. Failed edits (e.g. old_string not found) DO count. Five flailing
#      attempts is also pathology worth interrupting, even if the file
#      content is unchanged.
#
# State file lifecycle:
#   - Created lazily on the first Edit in the session.
#   - Cleaned at SessionStart (mirrors .claude/wip-checklist.md lifecycle —
#     see .claude/hooks/session-start.sh § "Clear stale checklist").
#   - Per-slot: each slot has its own .claude/ directory, so per-file
#     counts never leak between concurrent slots.
#
# Override knobs:
#   CLAUDE_EDIT_CHURN_CAP=N      # positive integer; default 5. Invalid
#                                # values (0, negative, non-numeric) disable
#                                # the hook with a stderr warning.
#   CLAUDE_EDIT_CHURN_DISABLE=1  # bypass the hook entirely (testing/recovery)
#
# Fail-open: any internal error (missing jq, malformed input, write
# failure, invalid CAP) exits 0 with a stderr warning. The hook must
# never brick a session — the cap is a productivity guardrail, not a
# security boundary.
#
# Security: file paths from tool_input flow into agent-visible stderr.
# Control characters and angle brackets are stripped before emission to
# prevent prompt injection via crafted paths (e.g. embedded
# </system-reminder> tags).
#
# See QUA-1070.

set -uo pipefail

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
COUNTS_FILE="$REPO_ROOT/.claude/.edit-counts.json"
CAP="${CLAUDE_EDIT_CHURN_CAP:-5}"

if [ -n "${CLAUDE_EDIT_CHURN_DISABLE:-}" ]; then
  exit 0
fi

# Validate CAP is a positive integer. Without this, CAP=abc / 0 / -1 / ""
# silently flips behavior to "block every Edit" because [ -lt ] errors and
# the comparison evaluates as false, falling through to the BLOCKED branch.
if ! [[ "$CAP" =~ ^[1-9][0-9]*$ ]]; then
  echo "cap-edit-churn: CLAUDE_EDIT_CHURN_CAP must be a positive integer (got '$CAP') — hook disabled" >&2
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

# Extract tool name and the file path. Edit/Write use .tool_input.file_path;
# NotebookEdit uses .tool_input.notebook_path. Falls back to empty string for
# unknown tools so the early-exit guard below catches them. Defaults keep the
# read non-fatal when the upstream payload changes shape.
read -r TOOL_NAME FILE_PATH < <(echo "$INPUT_JSON" \
  | jq -r '[(.tool_name // ""), (.tool_input.file_path // .tool_input.notebook_path // "")] | @tsv' 2>/dev/null \
  || echo $'\t')

# Match the matcher in settings.json. Edit and Write are the documented churn
# vectors; the ticket's pathology data only sampled Edit, but Write-to-existing-
# file is the most extreme form of churn (rewriting the whole file) and a
# coverage gap if not included. NotebookEdit added for parity.
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Atomic increment: read existing counts, bump, write to temp, mv into
# place. mv on the same filesystem is atomic. Concurrent Edits to the
# same file can race in the read-modify-write window; under-counting by
# 1-2 is acceptable for a soft heuristic.
mkdir -p "$(dirname "$COUNTS_FILE")"

# Trap cleans up the tmp file if the hook is killed (5s timeout in
# settings.json) between the write and the mv. Without this, the slot's
# .claude/ slowly fills with .edit-counts.json.tmp.<pid> orphans.
TMP="$COUNTS_FILE.tmp.$$"
trap 'rm -f "$TMP"' EXIT

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

# Extract COUNT before the write so a malformed value never persists.
COUNT=$(echo "$NEW" | jq -r --arg f "$FILE_PATH" '.[$f]')
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  exit 0
fi

if ! { printf '%s\n' "$NEW" > "$TMP" && mv "$TMP" "$COUNTS_FILE"; }; then
  echo "cap-edit-churn: could not write $COUNTS_FILE — hook disabled for this turn" >&2
  exit 0
fi

# Cap allows up to CAP edits (inclusive). The CAP+1 edit is the one that
# blocks. With default CAP=5: edits 1-5 silent, edit 6 fires the block.
# Matches the rule wording "after 5 edits to the same file...STOP."
if [ "$COUNT" -le "$CAP" ]; then
  exit 0
fi

# At or over cap — emit revert/replan reminder. Exit 2 surfaces stderr
# to the agent as feedback for the next turn.
#
# Sanitize FILE_PATH before emission. The text below becomes agent-visible
# context; a path containing newlines, control chars, or angle-bracketed
# tags like </system-reminder> could inject instructions into the next
# turn. Strip the dangerous chars; the agent still recognizes the path.
SAFE_PATH=$(printf '%s' "$FILE_PATH" | tr -d '\000-\037<>')

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

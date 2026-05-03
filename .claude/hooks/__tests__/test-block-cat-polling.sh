#!/usr/bin/env bash
#
# Smoke test for .claude/hooks/block-cat-polling.sh (QUA-1069).
#
# Verifies:
#   - real W18 worst-case patterns match
#   - cat / tail / stat verbs are all caught
#   - counter is per-session (different session_ids don't share a counter)
#   - threshold is exactly 3 (1 and 2 silent, 3+ blocks)
#   - the slot path shape (lw/aN) is detected
#   - Edit/Write tool calls are ignored (Bash-only matcher)
#   - heredoc bodies and -m "..." commit messages don't false-positive
#   - missing session_id / unparseable input fail open
#
# Run: bash .claude/hooks/__tests__/test-block-cat-polling.sh
#
# Exit code: 0 on all-pass, 1 on any failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/block-cat-polling.sh"

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
export CLAUDE_PROJECT_DIR="$TEST_DIR"
mkdir -p "$TEST_DIR/.claude/hooks"
cp "$HOOK" "$TEST_DIR/.claude/hooks/block-cat-polling.sh"
HOOK="$TEST_DIR/.claude/hooks/block-cat-polling.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
pass() { PASS=$((PASS+1)); }

invoke() {
  local cmd="$1"
  local sid="${2:-test-session-uuid}"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg sid "$sid" \
    '{tool_name:"Bash",session_id:$sid,tool_input:{command:$cmd}}')
  echo "$payload" | bash "$HOOK" 2>/dev/null
  echo $?
}

invoke_stderr() {
  local cmd="$1"
  local sid="${2:-test-session-uuid}"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg sid "$sid" \
    '{tool_name:"Bash",session_id:$sid,tool_input:{command:$cmd}}')
  echo "$payload" | bash "$HOOK" 2>&1 1>/dev/null
}

reset_session() {
  rm -rf "$TEST_DIR/.claude/.poll-counts"
}

# === Real W18 worst-case patterns (from c7413678 transcript) ===
echo "--- positive matches (W18 patterns) ---"
reset_session

# Direct shapes captured from the worst-case session:
W18_1='cat /private/tmp/claude-501/-Users-ozziegooen-Documents-GitHub-nosync-lw-a9/0227ce3f-ada3-40bb-9779-21a93d355472/tasks/b20pa3o91.output 2>&1 | tail -3; pgrep -lf "lw/a9.*validate-gate" >/dev/null 2>&1 && echo RUN || echo DONE; date'
W18_2='cat /private/tmp/claude-501/-Users-ozziegooen-Documents-GitHub-nosync-lw-a9/0227ce3f-ada3-40bb-9779-21a93d355472/tasks/b20pa3o91.output 2>&1 | tail; pgrep -lf "lw/a9.*validate-gate" >/dev/null 2>&1 && echo RUN || echo DONE'
W18_3='cat /private/tmp/claude-501/-Users-ozziegooen-Documents-GitHub-nosync-lw-a9/0227ce3f-ada3-40bb-9779-21a93d355472/tasks/b20pa3o91.output 2>&1; pgrep -lf "lw/a9.*validate-gate" >/dev/null 2>&1 && echo RUN || echo DONE; date'

R=$(invoke "$W18_1" "sid-A"); [ "$R" = "0" ] && pass || fail "1st cat-poll should exit 0 (got $R)"
R=$(invoke "$W18_2" "sid-A"); [ "$R" = "0" ] && pass || fail "2nd cat-poll should exit 0 (got $R)"
R=$(invoke "$W18_3" "sid-A"); [ "$R" = "2" ] && pass || fail "3rd cat-poll should exit 2 (got $R)"
R=$(invoke "$W18_1" "sid-A"); [ "$R" = "2" ] && pass || fail "4th cat-poll should keep blocking (got $R)"

# tail variant
reset_session
TAIL_CMD='tail -f /tmp/claude-501/foo/tasks/abc.output'
R=$(invoke "$TAIL_CMD" "sid-tail"); [ "$R" = "0" ] && pass || fail "tail #1 should exit 0 (got $R)"
R=$(invoke "$TAIL_CMD" "sid-tail"); [ "$R" = "0" ] && pass || fail "tail #2 should exit 0 (got $R)"
R=$(invoke "$TAIL_CMD" "sid-tail"); [ "$R" = "2" ] && pass || fail "tail #3 should exit 2 (got $R)"

# stat -f %z variant
reset_session
STAT_CMD='stat -f %z /tmp/claude-501/foo/tasks/abc.output'
R=$(invoke "$STAT_CMD" "sid-stat"); [ "$R" = "0" ] && pass || fail "stat #1 should exit 0 (got $R)"
R=$(invoke "$STAT_CMD" "sid-stat"); [ "$R" = "0" ] && pass || fail "stat #2 should exit 0 (got $R)"
R=$(invoke "$STAT_CMD" "sid-stat"); [ "$R" = "2" ] && pass || fail "stat #3 should exit 2 (got $R)"

# Slot path (lw/aN — QUA-471 lore: ensure slug-style paths inside the slot match)
reset_session
SLOT_CMD='cat /private/tmp/claude-501/-Users-ozziegooen-Documents-GitHub-nosync-lw-a9/aaaa-bbbb-cccc/tasks/b6t64p6s1.output 2>&1; ps -p 74799 >/dev/null 2>&1 && echo RUN || echo DONE'
R=$(invoke "$SLOT_CMD" "sid-slot"); [ "$R" = "0" ] && pass || fail "slot #1 should exit 0 (got $R)"
R=$(invoke "$SLOT_CMD" "sid-slot"); [ "$R" = "0" ] && pass || fail "slot #2 should exit 0 (got $R)"
R=$(invoke "$SLOT_CMD" "sid-slot"); [ "$R" = "2" ] && pass || fail "slot #3 should exit 2 (got $R)"

STDERR=$(invoke_stderr "$SLOT_CMD" "sid-slot")
echo "$STDERR" | grep -q "BLOCKED" && pass || fail "stderr should contain BLOCKED"
echo "$STDERR" | grep -q "Monitor" && pass || fail "stderr should mention Monitor"
echo "$STDERR" | grep -q "ToolSearch" && pass || fail "stderr should mention ToolSearch"
echo "$STDERR" | grep -q "wait-on-subagents.md" && pass || fail "stderr should reference rule file"

# === Session isolation ===
echo "--- session isolation ---"
reset_session
R=$(invoke "$W18_1" "session-X"); [ "$R" = "0" ] && pass || fail "session-X #1"
R=$(invoke "$W18_1" "session-X"); [ "$R" = "0" ] && pass || fail "session-X #2"
R=$(invoke "$W18_1" "session-Y"); [ "$R" = "0" ] && pass || fail "session-Y #1 (independent counter)"
R=$(invoke "$W18_1" "session-X"); [ "$R" = "2" ] && pass || fail "session-X #3 (blocks)"
R=$(invoke "$W18_1" "session-Y"); [ "$R" = "0" ] && pass || fail "session-Y #2 still allowed"
R=$(invoke "$W18_1" "session-Y"); [ "$R" = "2" ] && pass || fail "session-Y #3 blocks independently"

# === Negative cases (should NEVER block) ===
echo "--- negative cases ---"
reset_session

R=$(invoke 'cat /tmp/foo.log' "sid-neg"); [ "$R" = "0" ] && pass || fail "regular cat should not match"
R=$(invoke 'cat README.md' "sid-neg"); [ "$R" = "0" ] && pass || fail "cat of project file should not match"
R=$(invoke 'cat /tmp/claude-501/something/else.log' "sid-neg"); [ "$R" = "0" ] && pass || fail "non-tasks /tmp/claude-* should not match"
R=$(invoke 'cat /tmp/foo/tasks/x.output' "sid-neg"); [ "$R" = "0" ] && pass || fail "tasks/ outside /tmp/claude-* should not match"

# 3 of these should still not block — none match the polling pattern
R=$(invoke 'cat README.md' "sid-neg"); [ "$R" = "0" ] && pass || fail "non-poll #1"
R=$(invoke 'cat README.md' "sid-neg"); [ "$R" = "0" ] && pass || fail "non-poll #2"
R=$(invoke 'cat README.md' "sid-neg"); [ "$R" = "0" ] && pass || fail "non-poll #3"

# Edit/Write should be ignored — Bash matcher only
EDIT_PAYLOAD=$(jq -n '{tool_name:"Edit",session_id:"sid-edit",tool_input:{file_path:"/tmp/claude-501/foo/tasks/x.output"}}')
echo "$EDIT_PAYLOAD" | bash "$HOOK" 2>/dev/null
[ "$?" = "0" ] && pass || fail "Edit tool should be ignored"

# Heredoc body containing the path shape — should not count
reset_session
HEREDOC_CMD=$'cat <<\'EOF\' > /tmp/note.md\nDo NOT do `cat /tmp/claude-501/foo/tasks/x.output` — use Monitor.\nEOF'
R=$(invoke "$HEREDOC_CMD" "sid-here"); [ "$R" = "0" ] && pass || fail "heredoc body #1"
R=$(invoke "$HEREDOC_CMD" "sid-here"); [ "$R" = "0" ] && pass || fail "heredoc body #2"
R=$(invoke "$HEREDOC_CMD" "sid-here"); [ "$R" = "0" ] && pass || fail "heredoc body #3"

# git commit -m "..." with the path shape inside the message
reset_session
COMMIT_CMD='git commit -m "fix: block cat /tmp/claude-501/x/tasks/y.output polling"'
R=$(invoke "$COMMIT_CMD" "sid-commit"); [ "$R" = "0" ] && pass || fail "commit -m message #1"
R=$(invoke "$COMMIT_CMD" "sid-commit"); [ "$R" = "0" ] && pass || fail "commit -m message #2"
R=$(invoke "$COMMIT_CMD" "sid-commit"); [ "$R" = "0" ] && pass || fail "commit -m message #3"

# === Fail-open cases ===
echo "--- fail-open ---"

# missing session_id
reset_session
NO_SID=$(jq -n '{tool_name:"Bash",tool_input:{command:"cat /tmp/claude-501/foo/tasks/x.output"}}')
echo "$NO_SID" | bash "$HOOK" 2>/dev/null
[ "$?" = "0" ] && pass || fail "missing session_id should fail open"

# unparseable input
echo "this is not json" | bash "$HOOK" 2>/dev/null
[ "$?" = "0" ] && pass || fail "non-json input should fail open"

# empty input
echo "" | bash "$HOOK" 2>/dev/null
[ "$?" = "0" ] && pass || fail "empty input should fail open"

echo
echo "=================================="
echo "PASS: $PASS    FAIL: $FAIL"
echo "=================================="
[ "$FAIL" -eq 0 ]

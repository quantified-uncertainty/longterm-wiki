#!/usr/bin/env bash
#
# UserPromptSubmit hook — injects .claude/wip-checklist.md state into every
# user turn as a <system-reminder>, so the agent can't "forget" the checklist
# exists after /agent-init prints it once. Silent no-op when the file is
# missing (quick-fix sessions, pre-init turns). See QUA-515.
#

set -uo pipefail

# CODEX_PROJECT_DIR is preferred; CLAUDE_PROJECT_DIR keeps the hook usable in legacy sessions.
REPO_ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
CHECKLIST="$REPO_ROOT/.claude/wip-checklist.md"

if [ ! -f "$CHECKLIST" ]; then
  exit 0
fi

# grep -c exits non-zero on zero matches, so use wc -l + tr to keep counts
# clean for arithmetic. POSIX [[:space:]] for BSD/GNU portability (macOS sed
# doesn't grok \s).
count_lines() {
  grep -E "$1" "$CHECKLIST" 2>/dev/null | wc -l | tr -d '[:space:]'
}
DONE=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[x\][[:space:]]+`')
NA=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[~\][[:space:]]+`')
TODO=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[ \][[:space:]]+`')
TOTAL=$((DONE + NA + TODO))

if [ "$TOTAL" -eq 0 ]; then
  exit 0
fi

UNCHECKED_SLUGS=""
if [ "$TODO" -gt 0 ]; then
  # awk pulls only the FIRST backtick-wrapped token per line — defends against
  # human labels containing backticks like "Use `foo` to bar". tr -d '<>'
  # strips angle brackets so a crafted slug can't inject `</system-reminder>`
  # into the reminder block below.
  UNCHECKED_SLUGS=$(awk '
    /^[[:space:]]*[0-9]+\.[[:space:]]+\[ \][[:space:]]+`/ {
      n = split($0, parts, "`")
      if (n >= 3) print parts[2]
    }
  ' "$CHECKLIST" 2>/dev/null \
    | tr -d '<>' \
    | paste -sd ',' - \
    | sed 's/,/, /g')
fi

echo "<system-reminder>"
echo "Session checklist: $DONE/$TOTAL done${NA:+ ($NA N/A)}. File: .claude/wip-checklist.md"
if [ "$TODO" -gt 0 ]; then
  echo "Unchecked: $UNCHECKED_SLUGS"
  echo ""
  echo "Before shipping, work through every unchecked item or mark it N/A with a justification. Don't end the session until each item has a disposition. The Stop hook will block session-end if items remain unchecked."
fi
echo "</system-reminder>"

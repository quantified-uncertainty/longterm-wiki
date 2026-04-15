#!/usr/bin/env bash
#
# UserPromptSubmit hook — surfaces .claude/wip-checklist.md state on every user turn.
#
# Why: the checklist is created by `crux sys agent-checklist init` at session
# start but nothing makes the agent re-read it mid-session. Under context
# pressure, agents reliably forget the file exists and skip the quality gates
# the checklist was meant to enforce. See QUA-515.
#
# What: emits a compact <system-reminder> with the progress count and the slugs
# of unchecked items. Emitted to stdout, which Claude Code injects as context
# for the upcoming turn.
#
# When: every user-prompt turn. No-op if .claude/wip-checklist.md is missing
# (so quick-fix sessions that skip /agent-init don't get noise).
#
# Format reference for the checklist:
#   1. [ ] `slug-name` Human label
#   2. [x] `slug-name` Human label    (done)
#   15. [~] `slug-name` Human label   (N/A)
#

set -uo pipefail

# Prefer the harness-provided project dir. Fall back to script-relative path
# for manual testing. Using CLAUDE_PROJECT_DIR is robust against symlinks and
# worktree drift (where script-relative resolution can land in the wrong clone).
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CHECKLIST="$REPO_ROOT/.claude/wip-checklist.md"

# No checklist → silent no-op. Quick-fix sessions and pre-/agent-init turns
# should not get the reminder.
if [ ! -f "$CHECKLIST" ]; then
  exit 0
fi

# Count items by status. Match lines like "N. [ ] `slug` ..." anchored to the
# bracket pair so we don't accidentally count list bullets in the "Key Decisions"
# section. `grep -c` exits non-zero on zero matches, so we fall through to wc -l
# and tr to keep the count clean (no trailing newline that breaks $((arithmetic))).
count_lines() {
  grep -E "$1" "$CHECKLIST" 2>/dev/null | wc -l | tr -d '[:space:]'
}
# Use POSIX character classes for BSD/GNU portability (macOS sed doesn't grok \s).
DONE=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[x\][[:space:]]+`')
NA=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[~\][[:space:]]+`')
TODO=$(count_lines '^[[:space:]]*[0-9]+\.[[:space:]]+\[ \][[:space:]]+`')
TOTAL=$((DONE + NA + TODO))

# Empty checklist (no items matched) → no-op. The file might be malformed or
# in the middle of being written.
if [ "$TOTAL" -eq 0 ]; then
  exit 0
fi

# Extract slugs of unchecked items. Each line looks like:
#   N. [ ] `slug-name` Human label
# We grep for those lines, then pull just the first backtick-wrapped token.
# Two-stage so we can use a tight POSIX ERE on each side.
UNCHECKED_SLUGS=""
if [ "$TODO" -gt 0 ]; then
  # awk: on each unchecked line, pull just the FIRST backtick-wrapped token
  # (the slug). Defends against human labels that themselves contain backticks
  # like "Use `foo` to bar".
  # Strip angle brackets from slugs to prevent prompt-injection via a
  # crafted `</system-reminder>` slug leaking into the reminder block below.
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

# Emit a system-reminder-style block. Claude Code picks this up from stdout
# and injects it as context for the upcoming turn. The MEMORY.md auto-context
# loader uses the same channel.
echo "<system-reminder>"
echo "Session checklist: $DONE/$TOTAL done${NA:+ ($NA N/A)}. File: .claude/wip-checklist.md"
if [ "$TODO" -gt 0 ]; then
  echo "Unchecked: $UNCHECKED_SLUGS"
  echo ""
  echo "Before shipping, work through every unchecked item or mark it N/A with a justification. Don't end the session until each item has a disposition. The Stop hook will block session-end if items remain unchecked."
fi
echo "</system-reminder>"

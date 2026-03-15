#!/usr/bin/env bash
#
# PreToolUse hook for Bash — block commands that will hang waiting for input.
#
# Detects interactive commands (cp -i, mv -i, rm -i, git rebase -i, etc.)
# and rejects them with a helpful error message.
#
# Input: JSON on stdin with tool_input.command
#

set -uo pipefail

INPUT=$(cat 2>/dev/null || true)

# Extract command from JSON input — bail silently if parsing fails
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# ─── Block explicitly interactive flags ──────────────────────────────────────
# Only match commands at the START of a line or after && / || / ; / |
# This avoids false positives on text inside commit messages or strings.

# cp -i, mv -i, rm -i — as actual commands (start of line or after shell operators)
if echo "$COMMAND" | grep -qE '(^|&&|\|\||;|\|)\s*(cp|mv|rm)\s+-i\b'; then
  echo "BLOCK: Command uses interactive flag (-i) which will hang waiting for input." >&2
  echo "Use -f flag instead, or use 'command cp' to bypass shell aliases." >&2
  exit 2
fi

# git rebase -i, git add -i — as actual commands
if echo "$COMMAND" | grep -qE '(^|&&|\|\||;|\|)\s*git\s+(rebase|add|stash)\s+.*-i\b'; then
  echo "BLOCK: Interactive git commands (git rebase -i, git add -i) require stdin input." >&2
  exit 2
fi

exit 0

#!/bin/bash
# Block commands that cd into or operate on other agent slots.
# Each slot is an independent workspace — touching another slot's files
# can corrupt active sessions and cause irreversible data loss.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Get current slot from the agent project directory.
# Codex sets CODEX_PROJECT_DIR; Claude Code sets CLAUDE_PROJECT_DIR.
REPO_ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
CURRENT_SLOT=$(basename "$REPO_ROOT")

# Check for cd/pushd into other slot directories
if echo "$COMMAND" | grep -qE '(cd|pushd)\s+.*/lw/a[0-9]+' ; then
  # Extract the target slot
  TARGET=$(echo "$COMMAND" | grep -oE '/lw/a[0-9]+' | head -1 | sed 's|.*/||')
  if [ "$TARGET" != "$CURRENT_SLOT" ] && [ -n "$TARGET" ]; then
    echo "BLOCKED: Cannot cd into slot $TARGET — it may have an active agent session."
    echo "  You own slot $CURRENT_SLOT only. Other slots are off-limits."
    echo "  For branch isolation, use /tmp/ worktrees from lw/main instead."
    exit 2
  fi
fi

# Also block pkill/killall that could hit other sessions
if echo "$COMMAND" | grep -qE '(pkill|killall)\s+.*(codex|claude|next|node)'; then
  echo "BLOCKED: pkill/killall commands targeting codex/claude/next/node are prohibited."
  echo "  They can kill processes in other agent slots."
  echo "  Kill specific PIDs instead, after verifying they belong to your session."
  exit 2
fi

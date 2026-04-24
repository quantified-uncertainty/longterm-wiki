#!/usr/bin/env bash
# PreToolUse hook: blocks raw `gh pr create` — agents must use
# `crux gh pr create`, which auto-injects Linear references (Fixes QUA-NNN)
# into the PR body so issues auto-close on merge.
#
# Reads the official stdin JSON protocol (every other hook in this dir does
# the same). The previous CLAUDE_TOOL_INPUT env-var pattern was unreliable
# in past Claude Code versions and silently no-op'd; flagged by CodeRabbit
# on PR #4576.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL_NAME" != "Bash" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Match `gh pr create` but not `crux gh pr create` or `pnpm crux gh pr create`.
if echo "$COMMAND" | grep -qE '(^|[;&|]\s*)gh\s+pr\s+create\b'; then
  echo "BLOCKED: Use \`pnpm crux gh pr create\` instead of raw \`gh pr create\`." >&2
  echo "The crux wrapper auto-injects Linear issue references (Fixes QUA-NNN) so issues auto-close on PR merge." >&2
  exit 2
fi

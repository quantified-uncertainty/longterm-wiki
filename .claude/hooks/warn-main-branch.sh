#!/usr/bin/env bash
#
# PreToolUse hook: warns when editing files while on the main branch.
# Agents should always work on feature branches, never directly on main.
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to Claude as error)

BRANCH=$(git -C "$CLAUDE_PROJECT_DIR" branch --show-current 2>/dev/null)

if [ "$BRANCH" = "main" ]; then
  echo "BLOCKED: You are on the main branch. Create a feature branch first (git checkout -b claude/<description>). Never edit code directly on main." >&2
  exit 2
fi

exit 0

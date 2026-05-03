#!/usr/bin/env bash
#
# PreToolUse hook: warns when editing files while on the main branch.
# Agents should always work on feature branches, never directly on main.
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to the agent as error)

REPO_ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
BRANCH=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)

if [ "$BRANCH" = "main" ]; then
  echo "BLOCKED: You are on the main branch. Create a feature branch first (e.g. \`git checkout -b claude/<description>\` or \`git checkout -b codex/<description>\`). Never edit code directly on main." >&2
  exit 2
fi

exit 0

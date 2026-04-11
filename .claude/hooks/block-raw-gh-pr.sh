#!/usr/bin/env bash
# Block raw `gh pr create` — agents must use `crux gh pr create` which auto-injects
# Linear issue references (Fixes QUA-NNN) into the PR body.
# Without this, PRs miss the Linear linkage and issues don't auto-close on merge.

COMMAND="${CLAUDE_TOOL_INPUT:-}"

# Match `gh pr create` but not `crux gh pr create` or `pnpm crux gh pr create`
if echo "$COMMAND" | grep -qE '^\s*gh\s+pr\s+create'; then
  echo "BLOCKED: Use \`pnpm crux gh pr create\` instead of raw \`gh pr create\`."
  echo "The crux wrapper auto-injects Linear issue references (Fixes QUA-NNN) so issues auto-close on PR merge."
  exit 1
fi

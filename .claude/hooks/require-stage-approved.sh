#!/usr/bin/env bash
# PreToolUse hook: gate `gh pr merge ...` on `stage:approved` label and
# zero unresolved CodeRabbit Major/Critical/Potential-issue review threads.
# All logic lives in TypeScript (testable, typed); this is a thin wrapper
# that reads the official stdin JSON protocol and forwards the command.
#
# Override: ALLOW_UNAPPROVED_MERGE=1 gh pr merge <N> ...
#
# Exit codes: 0 = allow, 2 = block (stderr -> agent as the reason).

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL_NAME" != "Bash" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$COMMAND" ] && exit 0

REPO_ROOT="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}}"
exec env COMMAND="$COMMAND" npx --yes tsx \
  "$REPO_ROOT/crux/scripts/check-pr-merge-eligible.ts"

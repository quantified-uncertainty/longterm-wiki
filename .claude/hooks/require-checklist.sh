#!/usr/bin/env bash
#
# PreToolUse hook: blocks Edit/Write if no agent checklist has been initialized.
#
# Reads tool_input from stdin JSON. Allows edits to .claude/ files (plan files,
# checklist itself, memory, etc.) so the agent can still do meta-work.
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to Claude as error)
#

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECKLIST="$REPO_ROOT/.claude/wip-checklist.md"

# If checklist exists, allow everything
if [ -f "$CHECKLIST" ]; then
  exit 0
fi

# Read the file path from stdin JSON
FILE_PATH=$(jq -r '.tool_input.file_path // empty' < /dev/stdin 2>/dev/null || true)

# Allow edits to .claude/ files (plan files, memory, settings, etc.)
if [[ "$FILE_PATH" == *"/.claude/"* ]] || [[ "$FILE_PATH" == *".claude/"* ]]; then
  exit 0
fi

# Block: no checklist and trying to edit a non-.claude file
echo "BLOCKED: No agent checklist found. Run 'pnpm crux agent-checklist init' before editing code. This is mandatory — see .claude/rules/agent-session-workflow.md" >&2
exit 2

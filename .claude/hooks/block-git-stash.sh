#!/usr/bin/env bash
#
# PreToolUse hook: blocks `git stash` commands.
# Stashing causes branch confusion in multi-session slots — agents should
# commit work-in-progress or discard changes instead.
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to the agent as error)

# Only applies to Bash tool calls
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Strip heredocs/quoted strings to avoid false positives (e.g., commit messages mentioning "git stash")
# Only check the actual command, not content inside heredocs or -m "..." arguments
STRIPPED=$(echo "$COMMAND" | sed -E "s/<<'?[A-Za-z_]+'?//" | sed '/^EOF$/,$d' | sed -E 's/-m "[^"]*"//g' | sed -E "s/-m '[^']*'//g")

# Check if the stripped command contains `git stash` as an actual invocation
if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+stash\b'; then
  # Allow read-only and cleanup stash subcommands
  if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+stash\s+(list|show|drop|clear)\b'; then
    exit 0
  fi
  echo "BLOCKED: \`git stash\` is prohibited in agent sessions — it causes branch confusion when a later session pops state from a different branch/task. Instead:" >&2
  echo "  - Commit work-in-progress: \`git commit -m 'wip: description'\`" >&2
  echo "  - Discard changes: \`git checkout -- <file>\`" >&2
  echo "  - Create a new branch: \`git checkout -b claude/wip-<description>\` or \`git checkout -b codex/wip-<description>\`" >&2
  exit 2
fi

exit 0

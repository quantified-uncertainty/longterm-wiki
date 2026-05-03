#!/usr/bin/env bash
#
# PreToolUse hook: blocks `git push --no-verify` and `git commit --no-verify`.
# The pre-push gate now handles pre-existing main failures gracefully,
# so there's no legitimate reason to bypass hooks.
#
# Exit codes:
#   0 = allow the tool call
#   2 = block the tool call (stderr is shown to the agent as error)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)

if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Strip heredocs/quoted strings to avoid false positives
STRIPPED=$(echo "$COMMAND" | sed -E "s/<<'?[A-Za-z_]+'?//" | sed '/^EOF$/,$d' | sed -E 's/-m "[^"]*"//g' | sed -E "s/-m '[^']*'//g")

if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+(push|commit)\b.*--no-verify'; then
  echo "BLOCKED: \`--no-verify\` is prohibited. The pre-push gate handles pre-existing main CI failures gracefully — if main is red, the gate allows the push automatically. If the gate blocks you, the failure is from YOUR changes and needs to be fixed." >&2
  echo "" >&2
  echo "If the gate is wrong (false positive), ask the user for guidance instead of bypassing." >&2
  exit 2
fi

exit 0

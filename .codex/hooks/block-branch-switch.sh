#!/usr/bin/env bash
#
# PreToolUse hook: blocks branch-switching git commands.
# Switching branches mid-session causes cross-session confusion in multi-agent slots.
# Agents should use a slot or an explicit /tmp worktree instead.
#
# Allowed:
#   git checkout -b <new-branch>     (creating a new branch is safe)
#   git checkout -B <new-branch>     (creating/resetting a branch)
#   git checkout -- <file>           (discarding file changes, not a branch switch)
#   git checkout <file>              (ambiguous, but checked — if it's a file path, allowed)
#   git switch -c <new-branch>       (creating a new branch)
#   git switch --create <new-branch> (creating a new branch)
#
# Warned (allowed with stderr warning):
#   git checkout main                (needed for /agent-reset; warns but doesn't block)
#
# Blocked:
#   git checkout <existing-branch>   (switches the working tree to another branch)
#   git switch <existing-branch>     (same as checkout)
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

# Allow branch switching when AGENT_RESET=1 is set in the command
# (used by /agent-reset to intentionally return to main)
if echo "$COMMAND" | grep -qE 'AGENT_RESET=1'; then
  exit 0
fi

# Strip heredocs and quoted strings to avoid false positives
STRIPPED=$(echo "$COMMAND" | sed -E "s/<<'?[A-Za-z_]+'?//" | sed '/^EOF$/,$d' | sed -E 's/-m "[^"]*"//g' | sed -E "s/-m '[^']*'//g")

# Check for `git checkout` commands
if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+checkout\b'; then
  # Allow: git checkout -b / -B (creating new branch)
  if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+checkout\s+-[bB]\b'; then
    exit 0
  fi
  # Allow: git checkout -- <file> (discarding file changes)
  if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+checkout\s+--\s'; then
    exit 0
  fi
  # Allow (with warning): git checkout main — needed for /agent-reset end-of-session
  if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+checkout\s+main\b'; then
    echo "WARNING: Switching to main. This is only appropriate during /agent-reset (end-of-session cleanup). If you are mid-session, use worktree isolation instead." >&2
    exit 0
  fi
  # Block everything else (branch switching)
  echo "BLOCKED: \`git checkout <branch>\` is prohibited in agent sessions — it destroys the current branch context and causes cross-session confusion. Instead:" >&2
  echo "  - To work on another branch: use a slot or explicit /tmp worktree" >&2
  echo "  - To create a new branch: \`git checkout -b Codex/<description>\`" >&2
  echo "  - To discard file changes: \`git checkout -- <file>\`" >&2
  echo "  - To check CI on main: \`gh run list --branch main -L 3\`" >&2
  exit 2
fi

# Check for `git switch` commands
if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+switch\b'; then
  # Allow: git switch -c / --create (creating new branch)
  if echo "$STRIPPED" | grep -qE '(^|\||&&|;)\s*git\s+switch\s+(-c|--create)\b'; then
    exit 0
  fi
  # Block everything else
  echo "BLOCKED: \`git switch <branch>\` is prohibited in agent sessions. Use worktree isolation instead." >&2
  exit 2
fi

exit 0

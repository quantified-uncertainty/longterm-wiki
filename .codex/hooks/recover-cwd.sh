#!/usr/bin/env bash
#
# PostToolUse hook (Agent) — recover working directory after subagent returns.
#
# Agent worktree isolation has had known bugs where spawning a subagent
# contaminates the parent session's Bash CWD,
# leaving it pointing at the worktree path. When the worktree is
# cleaned up, ALL subsequent Bash commands fail permanently.
#
# This hook runs after every Agent tool call and checks whether the
# CWD is still valid. If it has drifted into a .claude/worktrees/
# path (or the path no longer exists), it attempts to restore the
# CWD to the agent project directory.
#
# Known issues tracked at:
#   https://github.com/anthropics/claude-code/issues/42282
#   https://github.com/anthropics/claude-code/issues/18236
#   https://github.com/anthropics/claude-code/issues/41010
#
# NOTE: This is a best-effort mitigation. The Bash tool validates CWD
# existence *before* executing commands, so if the CWD is already
# deleted by the time this hook runs, the hook itself may fail.
# The primary defense is to avoid subagent worktree isolation entirely.

set -uo pipefail

PROJECT_DIR="${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-}}"
if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

# Check if the current working directory exists and is valid
if ! cd "." 2>/dev/null; then
  # CWD is gone — try to recover
  cd "$PROJECT_DIR" 2>/dev/null || exit 0
  echo "WARNING: Working directory was deleted (likely a cleaned-up worktree). Recovered to $PROJECT_DIR" >&2
  exit 0
fi

# Check if we've drifted into a worktree path
CURRENT_DIR="$(pwd 2>/dev/null || true)"
if [[ "$CURRENT_DIR" == */.claude/worktrees/* ]]; then
  cd "$PROJECT_DIR" 2>/dev/null || exit 0
  echo "WARNING: CWD drifted into worktree ($CURRENT_DIR). Recovered to $PROJECT_DIR" >&2
  exit 0
fi

exit 0

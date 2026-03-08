#!/usr/bin/env bash
#
# SessionEnd hook — clean up stale git worktrees.
#
# Removes worktrees that meet ALL of these conditions:
#   1. Not the main worktree (the primary repo checkout)
#   2. No uncommitted changes (clean working tree)
#   3. Branch is either merged into main, or has a merged/closed PR
#
# Safety: never removes worktrees with uncommitted changes.
# Runs asynchronously so it doesn't block session exit.
#

set -uo pipefail

# ─── Find the main repo root ────────────────────────────────────────────────────
# We may be running from a worktree, so find the actual .git dir's parent.
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# If we're in a worktree, the .git file points to the main repo's .git/worktrees/<name>.
# Resolve to the real repo root.
if [ -f "$REPO_ROOT/.git" ]; then
  GIT_DIR_PATH=$(sed 's/^gitdir: //' "$REPO_ROOT/.git")
  REPO_ROOT=$(cd "$GIT_DIR_PATH/../../.." 2>/dev/null && pwd)
fi

# Verify we found a real git repo
if [ ! -d "$REPO_ROOT/.git" ]; then
  exit 0
fi

cd "$REPO_ROOT" || exit 0

# ─── Configuration ───────────────────────────────────────────────────────────────
LOG_FILE="$REPO_ROOT/.claude/worktree-cleanup.log"
CLEANED=0
SKIPPED=0
ERRORS=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# ─── Get main branch name ───────────────────────────────────────────────────────
MAIN_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$MAIN_BRANCH" ]; then
  MAIN_BRANCH="main"
fi

# ─── Prune worktrees with missing directories first ──────────────────────────────
git worktree prune 2>/dev/null || true

# ─── Collect worktree entries ────────────────────────────────────────────────────
# Parse porcelain output into parallel arrays to avoid subshell variable scoping.
PATHS=()
BRANCHES=()

CURRENT_PATH=""
CURRENT_BRANCH=""

while IFS= read -r line || [ -n "$CURRENT_PATH" ]; do
  case "$line" in
    "worktree "*)
      # If we have a pending entry from previous iteration, save it
      if [ -n "$CURRENT_PATH" ]; then
        PATHS+=("$CURRENT_PATH")
        BRANCHES+=("$CURRENT_BRANCH")
      fi
      CURRENT_PATH="${line#worktree }"
      CURRENT_BRANCH=""
      ;;
    "branch "*)
      CURRENT_BRANCH="${line#branch refs/heads/}"
      ;;
    "detached")
      CURRENT_BRANCH="__detached__"
      ;;
    "")
      if [ -n "$CURRENT_PATH" ]; then
        PATHS+=("$CURRENT_PATH")
        BRANCHES+=("$CURRENT_BRANCH")
        CURRENT_PATH=""
        CURRENT_BRANCH=""
      fi
      ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null; echo "")

# Flush any remaining entry
if [ -n "$CURRENT_PATH" ]; then
  PATHS+=("$CURRENT_PATH")
  BRANCHES+=("$CURRENT_BRANCH")
fi

# ─── Process each worktree ──────────────────────────────────────────────────────
for i in "${!PATHS[@]}"; do
  WT_PATH="${PATHS[$i]}"
  WT_BRANCH="${BRANCHES[$i]}"

  # Skip the main worktree
  if [ "$WT_PATH" = "$REPO_ROOT" ]; then
    continue
  fi

  # Skip if directory doesn't exist
  if [ ! -d "$WT_PATH" ]; then
    continue
  fi

  # Safety: skip worktrees with uncommitted changes
  if [ -n "$(git -C "$WT_PATH" status --porcelain 2>/dev/null | head -1)" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Determine if the branch is stale
  SHOULD_REMOVE=false

  if [ "$WT_BRANCH" = "__detached__" ]; then
    # Detached HEAD with clean working tree — safe to remove
    SHOULD_REMOVE=true
  elif [ -n "$WT_BRANCH" ]; then
    # Check 1: Is the branch merged into main?
    if git branch --merged "$MAIN_BRANCH" 2>/dev/null | sed 's/^[* ]*//' | grep -qFx "$WT_BRANCH"; then
      SHOULD_REMOVE=true
    fi

    # Check 2: Does this branch have a merged or closed PR?
    if [ "$SHOULD_REMOVE" = false ] && command -v gh >/dev/null 2>&1; then
      PR_STATE=$(gh pr view "$WT_BRANCH" --json state --jq .state 2>/dev/null || true)
      if [ "$PR_STATE" = "MERGED" ] || [ "$PR_STATE" = "CLOSED" ]; then
        SHOULD_REMOVE=true
      fi
    fi
  fi

  if [ "$SHOULD_REMOVE" = true ]; then
    log "Removing stale worktree: $WT_PATH (branch: ${WT_BRANCH:-detached})"
    if git worktree remove "$WT_PATH" --force 2>/dev/null; then
      CLEANED=$((CLEANED + 1))
      log "  -> Removed successfully"

      # Also delete the local branch if it still exists
      if [ "$WT_BRANCH" != "__detached__" ] && [ -n "$WT_BRANCH" ]; then
        git branch -d "$WT_BRANCH" 2>/dev/null || true
      fi
    else
      ERRORS=$((ERRORS + 1))
      log "  -> Failed to remove"
    fi
  else
    SKIPPED=$((SKIPPED + 1))
  fi
done

# ─── Summary ────────────────────────────────────────────────────────────────────
if [ "$CLEANED" -gt 0 ] || [ "$ERRORS" -gt 0 ]; then
  log "Cleanup summary: removed=$CLEANED skipped=$SKIPPED errors=$ERRORS"
fi

exit 0

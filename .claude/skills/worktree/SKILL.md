---
name: worktree
description: Create a /tmp/ worktree from the lw/main reference clone for an existing branch (or new branch from main), wire node_modules + .env symlinks, and report the path. Use whenever a coord session needs to make changes on a branch other than main — replaces the 6-step manual setup that gets repeated dozens of times per session.
disable-model-invocation: false
allowed-tools: Bash
---

# /worktree — One-Shot Worktree Setup

Coord sessions can't edit files on `main` (PreToolUse hook blocks it), so every PR fix needs a feature branch. The standard recipe — `git worktree add`, then 4 `ln -sf` calls for `node_modules` / `.env` — is ~6 commands and ~70 lines of context that gets repeated dozens of times in a long session. This skill collapses it to one call.

## Usage

```
/worktree <branch>           # check out an existing branch
/worktree -b <new-branch>    # create new branch from origin/main
```

`<branch>` may be either form (`claude/qua-665-foo` or `qua-665-foo` — the skill prefixes `claude/` automatically if missing).

## What it does

1. `git fetch origin <branch>` (if it exists) — silently skips if the branch is local-only.
2. `git worktree add /tmp/wt-<short-sha> <branch>` from the `lw/main` reference clone. The `<short-sha>` is the first 6 chars of the branch's HEAD (or `new-<rand>` for `-b`), so two simultaneous fixes don't collide.
3. Symlinks `node_modules`, `apps/web/node_modules`, `apps/wiki-server/node_modules`, and `.env` (→ `lw/.env.base`) so `pnpm` / `crux` / `vitest` work without re-installing.
4. Prints the absolute path so the user (or follow-up bash calls) can `cd` directly.

## Example

```
$ /worktree claude/qua-665-wire-t1-importers-to-propose
Worktree:    /tmp/wt-ac742e
Branch:      claude/qua-665-wire-t1-importers-to-propose (HEAD ac742e844)
Symlinked:   node_modules, apps/{web,wiki-server}/node_modules, .env
Ready:       cd /tmp/wt-ac742e
```

## Implementation

When invoked, run:

```bash
#!/usr/bin/env bash
set -euo pipefail

MAIN_CLONE="/Users/ozziegooen/Documents/GitHub.nosync/lw/main"
ENV_FILE="/Users/ozziegooen/Documents/GitHub.nosync/lw/.env.base"

# Parse args
NEW_BRANCH=""
BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b)        NEW_BRANCH="1"; shift ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    *)         BRANCH="$1"; shift ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "Usage: /worktree <branch>            (existing)" >&2
  echo "       /worktree -b <new-branch>     (new from origin/main)" >&2
  exit 1
fi

# Auto-prefix `claude/` if missing
if [[ ! "$BRANCH" =~ ^(claude/|main$|production$) ]]; then
  BRANCH="claude/$BRANCH"
fi

cd "$MAIN_CLONE"

if [[ -n "$NEW_BRANCH" ]]; then
  # Make sure origin/main is fresh, then create new branch from it
  git fetch origin main --quiet
  SHORT="new-$(printf '%04x' $RANDOM)"
  WT="/tmp/wt-${SHORT}"
  git worktree add -b "$BRANCH" "$WT" origin/main >&2
else
  git fetch origin "$BRANCH" --quiet 2>/dev/null || true
  HEAD_SHA=$(git rev-parse --short=6 "origin/$BRANCH" 2>/dev/null || git rev-parse --short=6 "$BRANCH" 2>/dev/null || echo "unknown")
  WT="/tmp/wt-${HEAD_SHA}"
  if [[ -d "$WT" ]]; then
    echo "Worktree already exists at $WT — reusing." >&2
    cd "$WT"
    git fetch origin "$BRANCH" --quiet 2>/dev/null || true
    git reset --hard "origin/$BRANCH" >&2 2>/dev/null || true
  else
    git worktree add "$WT" "$BRANCH" >&2
  fi
fi

# Symlink node_modules + env (idempotent)
ln -sfn "$MAIN_CLONE/node_modules" "$WT/node_modules"
mkdir -p "$WT/apps/web" "$WT/apps/wiki-server"
ln -sfn "$MAIN_CLONE/apps/web/node_modules" "$WT/apps/web/node_modules"
ln -sfn "$MAIN_CLONE/apps/wiki-server/node_modules" "$WT/apps/wiki-server/node_modules"
ln -sfn "$ENV_FILE" "$WT/.env"

# Report
NEW_HEAD=$(cd "$WT" && git rev-parse --short HEAD)
echo "Worktree:    $WT"
echo "Branch:      $BRANCH (HEAD $NEW_HEAD)"
echo "Symlinked:   node_modules, apps/{web,wiki-server}/node_modules, .env"
echo "Ready:       cd $WT"
```

## Cleanup

When you're done with a worktree (PR merged, abandoned, etc.):

```bash
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main
git worktree remove --force /tmp/wt-<short-sha>
```

The `ws refresh` loop also prunes stale worktrees automatically when their branch is merged.

## When NOT to use this

- For changes to `main` itself (you can't — there's a PreToolUse hook that blocks it).
- For large multi-file rebases where a slot agent would be more appropriate (use `./ws open <N> --claude` instead — slots have full Claude sessions).
- For changes touching `ops/` or release flow (use `coord/` directly via the release session).

#!/usr/bin/env bash
# /worktree implementation. Creates a /tmp/wt-<sha> git worktree from the
# lw/main reference clone, wires node_modules + .env symlinks, and reports
# the path. Safe to re-invoke (refuses to wipe dirty/divergent worktrees).
#
# See SKILL.md for argument forms and exit semantics.

set -euo pipefail

# Defaults derived from the script's own location: this script lives at
# <workspace>/<slot>/.agents/skills/worktree/worktree.sh, so 4 levels up is
# the workspace root that holds main/, ops/, .env.base, and slot dirs.
# Override LW_MAIN_CLONE / LW_ENV_BASE if your layout differs.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
MAIN_CLONE="${LW_MAIN_CLONE:-$WORKSPACE_ROOT/main}"
ENV_FILE="${LW_ENV_BASE:-$WORKSPACE_ROOT/.env.base}"

# ── arg parse ────────────────────────────────────────────────────────────
NEW_BRANCH=0
BRANCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -b)         NEW_BRANCH=1; shift ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: worktree.sh <branch>           (existing branch)"
      echo "       worktree.sh -b <new-branch>    (new from origin/main)"
      echo
      echo "Resolves MAIN_CLONE from \$LW_MAIN_CLONE (default: $MAIN_CLONE)."
      echo "Resolves ENV_FILE from \$LW_ENV_BASE  (default: $ENV_FILE)."
      exit 0
      ;;
    *)          BRANCH="$1"; shift ;;
  esac
done

if [[ -z "$BRANCH" ]]; then
  echo "Usage: worktree.sh <branch>            (existing)" >&2
  echo "       worktree.sh -b <new-branch>     (new from origin/main)" >&2
  exit 1
fi

# Validate paths now that we've handled --help / no-arg cases.
if [[ ! -d "$MAIN_CLONE/.git" ]]; then
  echo "worktree.sh: MAIN_CLONE does not look like a git clone: $MAIN_CLONE" >&2
  echo "  Set LW_MAIN_CLONE=/path/to/main-clone to override." >&2
  exit 1
fi
if [[ ! -e "$ENV_FILE" ]]; then
  echo "worktree.sh: ENV_FILE not found: $ENV_FILE" >&2
  echo "  Set LW_ENV_BASE=/path/to/.env to override (or remove the symlink step if not needed)." >&2
  exit 1
fi

# Auto-prefix `codex/` if missing (so `worktree qua-665-foo` works).
# Lowercase per .claude/rules/agent-session-workflow.md branch convention.
if [[ ! "$BRANCH" =~ ^(codex/|claude/|main$|production$) ]]; then
  BRANCH="codex/$BRANCH"
fi

cd "$MAIN_CLONE"

# ── new branch path ──────────────────────────────────────────────────────
if (( NEW_BRANCH )); then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo "Branch '$BRANCH' already exists locally. Re-invoke without -b to reuse it." >&2
    exit 1
  fi
  git fetch origin main --quiet
  WT="/tmp/wt-new-$(printf '%04x' "$RANDOM")"
  git worktree add -b "$BRANCH" "$WT" origin/main >&2
else
  # ── existing branch path ───────────────────────────────────────────────
  git fetch origin "$BRANCH" --quiet 2>/dev/null || true
  HEAD_SHA=$(git rev-parse --short=6 "origin/$BRANCH" 2>/dev/null \
            || git rev-parse --short=6 "$BRANCH" 2>/dev/null \
            || echo "unknown")
  WT="/tmp/wt-${HEAD_SHA}"

  if [[ -d "$WT" ]]; then
    # Reuse: refuse to clobber uncommitted or unpushed work.
    pushd "$WT" >/dev/null
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "Worktree already at $WT but has uncommitted changes — refusing to reuse." >&2
      echo "Either:" >&2
      echo "  - commit/discard those changes there, then re-run, or" >&2
      echo "  - remove the worktree:  git -C $MAIN_CLONE worktree remove --force $WT" >&2
      exit 1
    fi
    if [[ -n "$(git rev-list "origin/$BRANCH..HEAD" 2>/dev/null)" ]]; then
      echo "Worktree at $WT has commits ahead of origin/$BRANCH — refusing to reuse." >&2
      echo "Push them first, or remove the worktree if they're unwanted." >&2
      exit 1
    fi
    git fetch origin "$BRANCH" --quiet 2>/dev/null || true
    git reset --hard "origin/$BRANCH" >&2
    popd >/dev/null
    REUSED=" (reused & fast-forwarded)"
  else
    git worktree add "$WT" "$BRANCH" >&2
    REUSED=""
  fi
fi

# ── symlink node_modules + env (idempotent) ──────────────────────────────
ln -sfn "$MAIN_CLONE/node_modules" "$WT/node_modules"
mkdir -p "$WT/apps/web" "$WT/apps/wiki-server"
ln -sfn "$MAIN_CLONE/apps/web/node_modules" "$WT/apps/web/node_modules"
ln -sfn "$MAIN_CLONE/apps/wiki-server/node_modules" "$WT/apps/wiki-server/node_modules"
ln -sfn "$ENV_FILE" "$WT/.env"

# ── report ───────────────────────────────────────────────────────────────
NEW_HEAD=$(git -C "$WT" rev-parse --short HEAD)
echo "Worktree:    ${WT}${REUSED:-}"
echo "Branch:      $BRANCH (HEAD $NEW_HEAD)"
echo "Symlinked:   node_modules, apps/{web,wiki-server}/node_modules, .env"
echo "Ready:       cd $WT"

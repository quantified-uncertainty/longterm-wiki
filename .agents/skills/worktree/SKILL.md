---
name: worktree
description: Create a /tmp/wt-<sha> git worktree from the lw/main reference clone for an existing branch (or new branch from origin/main), wire node_modules + .env symlinks, and report the path. Use whenever a coord session needs to make changes on a branch other than main — replaces the 6-step manual recipe that gets repeated dozens of times in long PR-fixing sessions.
disable-model-invocation: false
allowed-tools: Bash
---

# /worktree — One-Shot Worktree Setup

Coord sessions can't edit files on `main` (PreToolUse hook blocks it), so every PR fix needs a feature branch. The standard recipe — `git worktree add`, then four `ln -sf` calls for `node_modules` / `.env` — gets repeated dozens of times in any long session. This skill collapses it to one call.

## Usage

```text
/worktree <branch>           # check out an existing branch
/worktree -b <new-branch>    # create new branch from origin/main
```

`<branch>` may be either form (`codex/qua-665-foo` or `qua-665-foo`); the skill prefixes `codex/` automatically when missing. The lowercase prefix matches the convention in `.claude/rules/agent-session-workflow.md`.

## Implementation

The skill executes `.agents/skills/worktree/worktree.sh`, passing through any args:

```bash
bash "${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}/.agents/skills/worktree/worktree.sh" "$@"
```

The script:

1. Fetches the branch from origin (silently skips if local-only).
2. Computes a `/tmp/wt-<short-sha>` path so two simultaneous fixes don't collide.
3. `git worktree add` (or, on `-b`, creates the branch from `origin/main`).
4. Symlinks `node_modules`, `apps/web/node_modules`, `apps/wiki-server/node_modules`, and `.env` (→ `lw/.env.base`) so `pnpm` / `crux` / `vitest` work without re-installing.
5. Prints the absolute path so the user (or follow-up Bash calls) can `cd` directly.

## Safety

The script **refuses to reuse** an existing worktree if it has either:

- uncommitted local changes (detected via `git status --porcelain`), or
- commits ahead of `origin/<branch>` (detected via `git rev-list origin/<branch>..HEAD`).

Both cases bail with an actionable message — wiping in-flight work has happened before in slot agents and the cost of a destructive reset isn't worth the convenience. To clear and start over, the user removes the worktree explicitly:

```bash
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/main worktree remove --force /tmp/wt-<sha>
```

## Example

```text
$ /worktree codex/qua-665-wire-t1-importers-to-propose
Worktree:    /tmp/wt-ac742e
Branch:      codex/qua-665-wire-t1-importers-to-propose (HEAD ac742e844)
Symlinked:   node_modules, apps/{web,wiki-server}/node_modules, .env
Ready:       cd /tmp/wt-ac742e
```

## When NOT to use this

- For changes to `main` itself (you can't — there's a PreToolUse hook that blocks it).
- For large multi-file rebases where a slot agent would be more appropriate (use `./ws open <N> --claude` instead — slots have full agent sessions; `--claude` is the existing flag name regardless of which runtime ends up attached).
- For changes touching `ops/` or release flow (use `coord/` directly via the release session).

## Cleanup

Manual:

```bash
git -C /Users/ozziegooen/Documents/GitHub.nosync/lw/main worktree remove --force /tmp/wt-<sha>
```

Automatic: `ws refresh` prunes stale worktrees when their branch is merged.

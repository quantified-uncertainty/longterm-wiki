# Slot Isolation — NEVER Touch Other Agent Slots

## The Rule

Each agent slot (`lw/a1` through `lw/a20`) is an **independent workspace** with its own Claude Code session. You own exactly ONE slot — the one you're running in. Every other slot is off-limits.

## What You Must NEVER Do

1. **Never `cd` into another slot's directory** — not even to "check" something
2. **Never dispatch subagents to another slot** — use `/tmp/` worktrees instead
3. **Never kill tmux windows** for other slots — they may have active sessions
4. **Never run commands** that affect other slots (e.g., `pkill` matching patterns that could hit their processes)
5. **Never assume a slot is idle** — what looks idle from outside may have hours of accumulated session context

## Why This Matters — Incident History

This rule exists because of two real incidents in a single session:

1. **Slot corruption**: A patrol agent dispatched subagents to a5 and a6 to fix PRs. Those slots had other sessions that were disrupted by the branch checkouts.
2. **Session destruction**: The same agent later killed "stale" tmux windows without checking. This destroyed an active Claude session in a3 that was working on PR #4010, losing all session context and in-progress reasoning.

## What To Do Instead

| Need | Solution |
|------|----------|
| Fix code on another branch | Create `/tmp/` worktree from `lw/main` clone |
| Edit PR metadata (body, labels) | Use `gh` CLI — no checkout needed |
| Check another slot's status | Use `./ws list` from the workspace root |
| Kill a process or tmux window | **Ask the user first** — always |

## For Patrol / Coordinator Sessions

PR patrol sessions frequently need to fix code on branches they don't own. The correct workflow:

```bash
# From the main clone (NOT from another slot):
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main
git fetch origin
git worktree add /tmp/fix-<PR#> <branch-name>
cd /tmp/fix-<PR#>
# ... symlink node_modules, fix, push ...
cd /Users/ozziegooen/Documents/GitHub.nosync/lw/main
git worktree remove /tmp/fix-<PR#>
```

## Destructive Actions Require Confirmation

Before ANY destructive action on shared resources, ask the user:
- Killing processes (`kill`, `pkill`)
- Removing tmux windows (`tmux kill-window`)
- Deleting files outside your slot
- Force-pushing to branches you didn't create

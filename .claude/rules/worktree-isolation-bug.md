# Worktree Isolation Bug — DO NOT USE `isolation: "worktree"`

## The bug

Claude Code has a confirmed, unpatched bug where `Agent(isolation: "worktree")` corrupts the parent session's Bash working directory. After the subagent finishes and the worktree is cleaned up, **all Bash commands in the parent session fail permanently** with "Working directory no longer exists." The session is unrecoverable — restart is the only option.

Tracked in multiple open issues (no official fix):
- [#42282](https://github.com/anthropics/claude-code/issues/42282) — CWD drift after subagent worktree
- [#18236](https://github.com/anthropics/claude-code/issues/18236) — Bash tool permanently broken after CWD deleted
- [#41010](https://github.com/anthropics/claude-code/issues/41010) — Worktree cleanup deletes parent session CWD
- [#27881](https://github.com/anthropics/claude-code/issues/27881) — Context compaction causes CWD drift into worktrees
- [#28363](https://github.com/anthropics/claude-code/issues/28363) — WorktreeRemove hook never fires for subagent worktrees

## Rule

**Never use `isolation: "worktree"` in Agent tool calls.** This applies to all sessions — coordinator, slot agents, and skills.

For branch isolation, use the agent workspace slots (`lw/a1`–`lw/a15`) which are full independent clones and do not trigger this bug.

## What happens without `isolation: "worktree"`

Agents spawned without worktree isolation run in the **same directory** as the parent session. This is fine for:
- Read-only research (searching, reading files, web fetches)
- Code analysis and review
- Running commands that don't modify the working tree

If you need an agent to modify files on a different branch, dispatch it to a slot:

- **Fire-and-forget, headless**: `./ws dispatch <N> "<prompt>"` (QUA-554). Returns a session id + run id; stream-JSON events are captured under `lw/aN/.dispatch/runs/<runId>/`. Watch with `./ws dispatch-status <N>`, stop with `./ws dispatch-stop <N>`.
- **Interactive oversight**: `./ws open <N> --claude` opens a tmux window and launches Claude Code.

Both are safe and do not trigger the worktree bug.

## Defenses in place

Even though the rule is "don't use it," we have layered defenses in case it happens accidentally:

1. **PostToolUse hook** (`.claude/hooks/recover-cwd.sh`): Attempts to restore CWD to `$CLAUDE_PROJECT_DIR` after Agent calls if drift is detected. Best-effort — may not catch all cases.
2. **Safer cleanup hook** (`.claude/hooks/cleanup-worktrees.sh`): Checks for processes with CWD inside a worktree before removing it. Skips removal if active.
3. **This rule file**: Loaded automatically into Claude Code sessions as a reminder.

---
name: agent-reset
description: Close the current agent session in the DB and reset the agent slot back to a clean main branch. Run this when finishing a feature — it handles DB cleanup, git reset, and local file cleanup in one step.
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Reset Agent Slot Directory

Close the current session and reset the working directory (agent slot) back to a clean `main` branch. Use this after finishing a feature and pushing/merging a PR.

This command handles the full session transition: DB close + git reset + local cleanup.

## Steps

1. **Close the session in the DB**: Run `pnpm crux sys agents close` to:
   - Mark the active agent as completed in the wiki-server DB
   - Mark the agent session as completed
   - Log a "completed" event
   - Clean up `.claude/agent-id`, `.claude/wip-checklist.md`, `.agent-task`, `.claude/last-heartbeat`

   ```bash
   pnpm crux sys agents close
   ```

2. **Identify the current state**: Run `git branch --show-current` and `git status --porcelain` to show the current branch and any uncommitted changes.

3. **Confirm with the user** if there are uncommitted changes or unpushed commits. Show them what will be lost. If the branch has been merged or the user confirms, proceed.

4. **Discard local changes**:
   ```bash
   git checkout -- .
   git clean -fd --exclude=.agent-slot --exclude=.envrc --exclude=.env
   ```

5. **Switch to main and pull latest** (prefix with `AGENT_RESET=1` to bypass the branch-switch hook):
   ```bash
   BRANCH=$(git branch --show-current)
   AGENT_RESET=1 git checkout main
   git pull --ff-only origin main
   ```

6. **Delete the old feature branch** (if it wasn't main):
   ```bash
   git branch -D "$BRANCH"
   ```

7. **Rename tmux window** (if in an agent slot with `.agent-slot`):
   ```bash
   SLOT=$(cat .agent-slot 2>/dev/null | tr -d '[:space:]')
   if [ -n "$SLOT" ] && [ -n "$TMUX" ]; then
     tmux rename-window "A${SLOT}"
   fi
   ```

8. **Clear the Codex session name** so the status line shows this slot is idle:
   Tell the user: "Run `/rename` to clear the session name" (skills can't invoke other slash commands directly).

9. **Report** the final state: branch, clean status, and slot number.

## Arguments

- `/agent-reset --force` — skip the confirmation step
- `/agent-reset` — confirm before discarding changes

## Important

- Always preserve `.agent-slot`, `.envrc`, and `.env` files (they're slot-specific config)
- Never delete the directory itself — just reset the git state
- If `git pull` fails (diverged history), use `git reset --hard origin/main` as fallback
- The DB close (step 1) is best-effort — if the wiki server is down, proceed with git reset anyway

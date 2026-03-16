---
name: reset-dir
description: Reset the current agent slot back to a clean main branch after finishing a feature. Discards all local changes, switches to main, pulls latest, and deletes the old feature branch.
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Reset Agent Slot Directory

Reset the current working directory (agent slot) back to a clean `main` branch. Use this after finishing a feature and pushing/merging a PR.

## Steps

1. **Identify the current state**: Run `git branch --show-current` and `git status --porcelain` to show the current branch and any uncommitted changes.

2. **Confirm with the user** if there are uncommitted changes or unpushed commits. Show them what will be lost. If the branch has been merged or the user confirms, proceed.

3. **Discard local changes**:
   ```bash
   git checkout -- .
   git clean -fd --exclude=.agent-slot --exclude=.envrc --exclude=.env
   ```

4. **Switch to main and pull latest**:
   ```bash
   BRANCH=$(git branch --show-current)
   git checkout main
   git pull --ff-only origin main
   ```

5. **Delete the old feature branch** (if it wasn't main):
   ```bash
   git branch -D "$BRANCH"
   ```

6. **Rename tmux window** (if in an agent slot with `.agent-slot`):
   ```bash
   SLOT=$(cat .agent-slot 2>/dev/null | tr -d '[:space:]')
   if [ -n "$SLOT" ] && [ -n "$TMUX" ]; then
     tmux rename-window "A${SLOT}"
   fi
   ```

7. **Remove .agent-task** if it exists:
   ```bash
   rm -f .agent-task
   ```

8. **Clear the Claude Code session name** so the status line shows this slot is idle:
   ```bash
   # Use the /rename built-in command by outputting the instruction
   ```
   Tell the user: "Run `/rename` to clear the session name" (skills can't invoke other slash commands directly).

9. **Report** the final state: branch, clean status, and slot number.

## Arguments

- `/reset-dir --force` — skip the confirmation step
- `/reset-dir` — confirm before discarding changes

## Important

- Always preserve `.agent-slot`, `.envrc`, and `.env` files (they're slot-specific config)
- Never delete the directory itself — just reset the git state
- If `git pull` fails (diverged history), use `git reset --hard origin/main` as fallback

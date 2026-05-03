---
name: "source-command-agent-init"
description: "Initialize an agent checklist and establish working context. Run at session start."
---

# source-command-agent-init

Use this skill when the user asks to run the migrated source command `agent-init`.

## Command Template

# Agent Session Start

Initialize an agent checklist and establish working context.

Run this at the start of a session, after understanding what the task is.

## Step 1: Run `crux sys agent-checklist init`

This single command does everything below in order:

1. **Syncs to main** — verifies the working tree is clean, switches to `main` if needed, and runs `git pull --ff-only origin main`. If the tree is dirty, it aborts and tells you what's uncommitted.
2. Generates `.claude/wip-checklist.md` for the session type (legacy path still used by repo tooling).
3. Auto-marks `issue-tracking` as N/A when no issue is given.
4. **Signals start on the Linear issue** (primary) — auto-detects a Linear ID from the branch name (`Codex/qua-NNN-*`) or task description (any bare `QUA-NNN` token), or takes `--linear=QUA-NNN` explicitly. Moves the issue to "In Progress" and posts a start comment. Best-effort: a Linear failure does not fail init.
5. **Signals start on the GitHub issue** (when `--issue=N` is given) — adds the `agent:working` label and posts the start comment. Best-effort: a GitHub failure does not fail init.
6. Prints the full checklist so you can scan it.

Pick the right invocation (**Linear is the primary tracker** — most issues are there):

- **Working on a Linear issue** (most common): start a branch `Codex/qua-NNN-description` and the ID is detected automatically, or pass `--linear=QUA-NNN` explicitly
- **Working on a legacy GitHub issue**: `pnpm crux sys agent-checklist init --issue=N` (auto-detects type from labels)
- **Not on any tracked issue**: `pnpm crux sys agent-checklist init "Task description" --type=X`

Both `--issue` and `--linear` can be passed together if the same task is tracked in both systems.

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands` (default: `infrastructure`).

### Recovery cases

- **Dirty working tree** → Stop. Ask the user whether to commit, stash, or discard. Do NOT bypass — the sync exists to keep sessions from accumulating cross-branch debris.
- **Pull is non-fast-forward** → Local main has diverged. Surface the error to the user; don't try to force-pull.
- **Intentionally continuing on the current branch** (e.g. resuming after a crash) → Re-run with `--no-sync`.

## Step 2: Assemble research context (optional but recommended)

For content sessions or any task tied to specific pages/entities/issues, gather context upfront to avoid 5-15 separate file reads:

```bash
# Context for a specific page you'll be editing:
pnpm crux context for-page <page-id>

# Context for a GitHub issue (finds related pages/entities automatically):
pnpm crux context for-issue <N>

# Context for an entity:
pnpm crux context for-entity <entity-id>

# Context for a free-text topic:
pnpm crux context for-topic "topic description"
```

Output is saved to `.claude/wip-context.md`. Read it once — it contains page metadata, related pages, backlinks, citation health, entity YAML, and frontmatter.

## Step 3: Highlight risky items

The init output already shows the full checklist. Briefly call out any items that look particularly important or risky for *this specific task* (e.g. "tests-written" matters more for a bugfix, "fix-escaping" matters for content edits, etc.). Don't re-paste the whole list — the user just saw it.

Throughout the session, check items off in `.claude/wip-checklist.md` as they are completed. When done, run `/agent-ship` (if shipping a PR) or `/agent-end` (if not).

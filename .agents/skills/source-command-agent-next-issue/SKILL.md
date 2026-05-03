---
name: "source-command-agent-next-issue"
description: "Pick up the next highest-priority Linear issue and start working on it."
---

# source-command-agent-next-issue

Use this skill when the user asks to run the migrated source command `agent-next-issue`.

## Command Template

# Next Issue

Pick up the next highest-priority issue and start working on it. **Linear is the primary issue tracker** — check Linear first, fall back to GitHub for legacy issues.

## Overview

This command helps you start a focused session on the most important open issue. It checks the Linear backlog (QUA team) for ready-to-work issues, applies priority ordering, and presents the top candidates for selection.

## Phase 1: Fetch and rank open issues

```bash
# Primary — Linear backlog:
pnpm crux linear search "status:Todo,Backlog"
```

Review the results. Priority ordering uses Linear's built-in priority field (Urgent > High > Medium > Low > None). If the Linear backlog is empty or `LINEAR_API_KEY` is not set, fall back to GitHub:

```bash
# Fallback — GitHub issues:
pnpm crux gh issues next
```

If the user passed a specific issue identifier (e.g., `QUA-184` or `#239`), skip ranking and go directly to that issue.

## Phase 2: Signal start on the chosen issue

Once you've chosen an issue:

```bash
# For a Linear issue (most common):
pnpm crux linear start QUA-NNN

# For a legacy GitHub issue:
pnpm crux gh issues start <ISSUE_NUM>
```

This will:
1. Post a start comment on the issue
2. Move to "In Progress" (Linear) or add `agent:working` label (GitHub)
3. Print a summary of the issue for context

**Output the issue title and key details** to your working context before starting implementation — this ensures you understand what's being asked.

## Phase 3: Understand the issue

Read the issue carefully. If the body contains acceptance criteria or examples, list them explicitly before coding. Ask yourself:

- What is the desired outcome?
- What files are likely to be involved?
- Are there related issues or PRs mentioned?

If the issue is ambiguous, look at context in the issue comments or related code before proceeding.

## Phase 4: Implement

Work through the issue using the standard development workflow:

1. Create a branch with the issue ID: `Codex/qua-NNN-description` (Linear) or `Codex/fix-NNN-description` (GitHub)
2. Make changes, following all relevant rules in `.claude/rules/`
3. Run validation: `pnpm crux w validate gate`

## Phase 5: Ship and close the loop

After the work is done:

```bash
# Linear:
pnpm crux linear done QUA-NNN --pr=<PR_URL>

# Legacy GitHub:
pnpm crux gh issues done <ISSUE_NUM> --pr=<PR_URL>
```

Then run `/agent-push-and-verify` as usual.

## Quick reference

```bash
# Linear (primary):
pnpm crux linear search "status:Todo"    # Browse ready issues
pnpm crux linear start QUA-NNN           # Signal start
pnpm crux linear done QUA-NNN --pr=URL   # Signal completion

# GitHub (legacy fallback):
pnpm crux gh issues next                 # Show next priority issue
pnpm crux gh issues start <N>            # Signal start
pnpm crux gh issues done <N> --pr=URL    # Signal completion
```

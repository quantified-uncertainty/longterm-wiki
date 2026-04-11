---
description: Pick up the next highest-priority issue (GitHub or Linear) and start working on it.
argument-hint: "[issue-number] [--source=github|linear]"
effort: medium
---

# Next Issue

Pick up the next highest-priority issue and start working on it. Supports both GitHub issues and Linear issues.

## Overview

This command helps you start a focused session on the most important open issue. It fetches open issues, applies priority ordering, filters out issues already being worked on, and presents the top candidates for selection.

## Phase 1: Fetch and rank open issues

### Option A: GitHub issues (default)

```bash
pnpm crux gh issues next
```

This outputs a ranked list of open GitHub issues — highest priority first — with their labels, age, and a brief description. The ranking uses:

1. **Priority labels** — `P0` > `P1` > `P2` > `P3` > unlabeled
2. **Issue age** — older issues rank slightly higher within the same tier
3. **Excluded** — issues labeled `agent:working`, `wontfix`, or `on-hold`

### Option B: Linear issues

```bash
pnpm crux linear next
```

This outputs a ranked list of ready Linear issues (Todo/Backlog states) from the QUA team. The ranking uses:

1. **Linear priority** — urgent > high > medium > low > none
2. **Labels** — `claude-ready`/`agent-ready` issues get a 1.5× boost
3. **Issue age** — older issues rank slightly higher within the same tier
4. **Excluded** — issues labeled `blocked`, `waiting`, `on-hold`, etc.

### Choosing a source

If the user specified `--source=linear` or asked for a Linear issue, use Option B. If `--source=github` or a GitHub issue, use Option A. If unspecified, **check both sources** and present the top candidate from each, then pick the higher-priority one.

To see the full queue from either source:
```bash
pnpm crux gh issues list     # All open GitHub issues
pnpm crux linear list         # All ready Linear issues
```

Review the list. If the top issue looks right, proceed. If not, pick a different one from the list and note why you skipped the top one.

## Phase 2: Signal start on the chosen issue

### For GitHub issues:

```bash
pnpm crux gh issues start <ISSUE_NUM>
```

This will:
1. Post a comment on the issue: "Claude Code starting work on this issue (branch: `<current-branch>`)"
2. Add the `agent:working` label to signal it's in flight
3. Print a summary of the issue title and body for context

### For Linear issues:

```bash
pnpm crux linear start <QUA-NNN>
```

This will:
1. Move the issue to "In Progress"
2. Post a comment with the branch name

**Important:** When working on a Linear issue, the branch name **must** contain the Linear ID for auto-close to work on merge:
```bash
git checkout -b claude/qua-NNN-description
```

## Phase 3: Understand the issue

Read the issue carefully. If the body contains acceptance criteria or examples, list them explicitly before coding. Ask yourself:

- What is the desired outcome?
- What files are likely to be involved?
- Are there related issues or PRs mentioned?

If the issue is ambiguous, look at context in the issue comments or related code before proceeding.

## Phase 4: Initialize the session checklist

Run `/agent-init` to set up the session tracking:

```bash
# GitHub issue:
pnpm crux sys agent-checklist init --issue=N

# Linear issue:
pnpm crux sys agent-checklist init "Task description" --linear=QUA-NNN

# Both (if the Linear issue maps to a GitHub issue):
pnpm crux sys agent-checklist init --issue=N --linear=QUA-NNN
```

## Phase 5: Implement

Work through the issue using the standard development workflow:

1. Make changes, following all relevant rules in `.claude/rules/`
2. Run validation: `pnpm crux w validate gate`
3. Write tests for new logic

## Phase 6: Ship and close the loop

Run `/agent-ship` to push, monitor CI, and close the session. It automatically:
- Updates GitHub issues (`crux gh issues done`)
- Updates Linear issues (`crux linear done --pr=URL`)
- Creates the session log

## Quick reference

```bash
# GitHub
pnpm crux gh issues next              # Show next priority GitHub issue
pnpm crux gh issues list              # List all open GitHub issues
pnpm crux gh issues start <N>         # Announce start + add agent:working label
pnpm crux gh issues done <N> --pr=URL # Announce completion + remove label

# Linear
pnpm crux linear next                 # Show next priority Linear issue
pnpm crux linear list                 # List all ready Linear issues
pnpm crux linear start <QUA-NNN>      # Move to In Progress + post start comment
pnpm crux linear done <QUA-NNN> --pr=URL  # Move to In Review + post done comment
```

---
description: Prioritized maintenance — review PRs, analyze session logs, triage issues, detect cruft, take action.
effort: medium
---

# Maintenance Sweep

Run a prioritized maintenance session: review recent PRs, analyze session logs, triage Linear/GitHub issues, detect codebase cruft, and take action.

## Overview

This command orchestrates a periodic maintenance sweep. It uses `crux sys maintain` for data gathering, then applies AI judgment for prioritization and execution. Run this after a batch of PRs merge, or on a regular cadence.

**Recommended cadences:**
- **Daily:** `crux sys maintain review-prs` — catch recurring issues from session logs
- **Weekly:** `crux sys maintain` — full sweep including issue triage
- **Monthly:** `crux sys maintain detect-cruft` — deep cruft analysis + cleanup

## Phase 1: Gather Signals

Run the full maintenance report to collect all signals:

```bash
pnpm crux sys maintain
```

This produces a combined report covering:
- **PR & Session Log Review**: Merged PRs, session log issues/learnings, recurring problems, multi-edited pages
- **Linear Queue Triage** (primary): Stale In Progress, stuck In Review, and P1/P2 ready-for-dispatch items
- **Legacy GitHub Issue Triage**: Issues categorized as potentially-resolved, stale, actionable, or keep
- **Codebase Cruft**: TODO/FIXME comments, large files, commented-out code

Additionally, check page content health:
```bash
pnpm crux w updates list --overdue --limit=5
pnpm crux w validate
```

Read the full report output carefully. It ends with a suggested priority order.

## Phase 2: Prioritize

The report categorizes work into priority tiers. Review the output and decide what to tackle:

| Priority | Category | Time | Description |
|----------|----------|------|-------------|
| **P0** | Fix broken things | Always | CI failures, blocking validation errors, broken imports |
| **P1** | Close resolved issues | ~1 min each | Issues that recent PRs already fixed — verify and close |
| **P2** | Propagate learnings | ~5 min | Add recurring session log issues to `common-issues.md` or rules |
| **P3** | Work actionable issues | Varies | Fix small issues directly; **file new Linear issues** for larger tasks found during the sweep |
| **P4** | Cruft cleanup | ~5 min each | Dead code removal, TODO resolution, file splitting |
| **P5** | Page content updates | Delegate | Run `pnpm crux w updates run` for content freshness |

**P0-P2 are always worth doing** (fast, high-value). Ask the user before spending time on P3-P5.

### Filing new issues

When the sweep reveals problems too large to fix now, **create Linear issues** so they aren't lost:
```bash
pnpm crux linear create "Descriptive title" \
  --description="What's wrong and why it matters"
```

To update existing Linear issues with context:
```bash
pnpm crux linear comment QUA-NNN "Status update from maintenance sweep"
```

This is a key output of maintenance — converting discovered problems into tracked work items.

### Issue tracking cleanup

**GitHub:** Check for stale `agent:working` labels on issues where the session has ended:
```bash
pnpm crux gh issues list   # shows "In Progress" section with agent:working issues
```
For each orphaned in-progress issue:
- If work completed: `pnpm crux gh issues done <N> --pr=<URL>` (posts comment + removes label)
- If work abandoned: post a comment explaining, then remove label via `crux gh issues done <N>`

**Linear:** Check the `triage-linear` report for stale issues:
```bash
pnpm crux sys maintain triage-linear   # shows stale In Progress, stuck In Review, dispatch queue
```
For stale In Progress issues with no active session:
- Move to Todo: `pnpm crux linear done QUA-NNN` then re-open, or use the API directly
- If PR was merged but issue not closed: `pnpm crux linear done QUA-NNN --pr=<URL>`
- Post context: `pnpm crux linear comment QUA-NNN "Maintenance: moved to Todo — no active session"`

## Phase 3: Execute

Work through the prioritized list:

### Closing resolved issues
For each issue the triage report flagged as "Potentially Resolved," verify it was actually fixed, then comment and close:
```bash
# GitHub issues
pnpm crux gh issues done <NUMBER> --pr=<PR_URL>

# Linear issues (if PR merged but issue still open)
pnpm crux linear done QUA-NNN --pr=<PR_URL>
# Or move directly to Done if already merged:
pnpm crux linear done QUA-NNN
```

### Propagating learnings
Edit `.claude/common-issues.md` or `.claude/rules/` files with patterns found in the session log review. Focus on recurring issues (flagged with `!!` in the report).

### Fixing actionable issues
For small issues: fix the code, following the standard workflow (edit, validate, test).
For larger discoveries: file a Linear issue (see above) and move on.

### Cruft cleanup
Only remove things you're confident are unused — grep thoroughly before deleting. Each change should be a focused, reviewable unit.

## Phase 4: Record & Ship

1. The `crux sys maintain` report auto-updates `.claude/maintain-last-run.txt`.
2. Write a session log summarizing what was done.
3. Commit all changes.
4. Run `/agent-push-and-verify`.

## Guardrails

- **Be conservative with issue closures.** When in doubt, comment with status rather than closing. The triage report's "potentially resolved" classification uses heuristic matching and can have false positives.
- **For cruft removal**, only remove things you're confident are unused. Grep thoroughly before deleting.
- **Don't modify wiki content directly.** Page updates go through the Crux pipeline (`crux w updates run` or `crux w content improve`).
- **If the sweep finds many items (>10 actionable)**, work on the top 5 and file the rest as Linear issues.
- **If a maintenance run takes >5 actions**, prefer multiple focused commits over one large commit.

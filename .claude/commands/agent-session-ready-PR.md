# Agent Session Ready PR

Verify the agent checklist is complete, polish the PR, and ship.

This command assumes `/agent-session-start` was run earlier and `.claude/wip-checklist.md` exists.

## Step 1: Check progress

Run `pnpm crux agent-checklist status` to see what remains.

If `.claude/wip-checklist.md` doesn't exist, generate one now with `pnpm crux agent-checklist init "Task description" --type=X` and work through ALL items before proceeding.

## Step 2: Complete unchecked items

For each unchecked item in the checklist:

1. **Can it be completed now?** Do it and check it off.
2. **Not applicable?** Mark with `[~]` in the checklist.
3. **Blocked?** Note why next to the item.

Pay special attention to:
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims.
- **Gate check**: `pnpm crux validate gate --fix` — record the exact test count.

## Step 3: Write / update PR description

Check if a PR exists and update it with: summary, key changes, test plan, issue references.

## Step 4: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 5: Session log

Create `.claude/sessions/YYYY-MM-DD_<branch-suffix>.yaml` per `.claude/rules/session-logging.md`.

## Step 6: Validate completion

Run `pnpm crux agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 7: Ship

Run `/push-and-ensure-green`.

## Step 8: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

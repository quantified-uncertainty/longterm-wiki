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
- **Paranoid review** (`paranoid-review`): Use the Task tool to spawn a fresh subagent with the full diff (`git diff main`) and this prompt: *"You are a paranoid code reviewer with no prior context. Find every bug, DRY violation, dead code, missing export, test coverage gap, hardcoded constant, and deferred work item in this diff. Be adversarial — assume something is wrong."* Paste findings here. Fix or document every issue before checking the item off.
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims.
- **Gate check**: `pnpm crux validate gate --fix` — record the exact test count.

## Step 3: Write / update PR description

Check if a PR exists using `pnpm crux pr detect` and update it with: summary, key changes, test plan, issue references. If no PR exists yet, `/push-and-ensure-green` will create one using `crux pr create`.

## Step 4: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 5: Session log

Run `pnpm crux agent-checklist snapshot` and capture the output — this is the `checks:` block for the session log.

Session logs are stored in the wiki-server PostgreSQL database (not committed to git). The checklist state is automatically synced to the DB when you use the `crux agent-checklist` commands. If no checklist was initialized, the snapshot will output `checks: {initialized: false}` — include that honestly in any session summaries.

## Step 6: Validate completion

Run `pnpm crux agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 7: Ship

Run `/push-and-ensure-green`.

## Step 8: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

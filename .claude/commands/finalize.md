# Finalize

Verify the session checklist is complete, polish the PR, and ship.

This command assumes `/kickoff` was run earlier and `.claude/wip-checklist.md` exists with progress tracked throughout the session.

## Step 1: Read the checklist

Read `.claude/wip-checklist.md`. If it doesn't exist, create one now from `.claude/checklist-template.md` and work through ALL items before proceeding — do not skip this.

## Step 2: Complete unchecked items

For each unchecked item in the checklist:

1. **Can it be completed now?** If yes, do it and check it off.
2. **Is it not applicable?** If it was supposed to be removed during kickoff but wasn't, remove it now with a note.
3. **Is it blocked or impossible?** Note why next to the item. This will be flagged in the final report.

Pay special attention to these commonly-skipped items:
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims. This catches hallucinated results.
- **Gate check**: `pnpm crux validate gate --fix` — record the exact test count.
- **Test plan verification**: Every item in the PR test plan must be re-verified right now. Delete items that aren't true. A shorter fully-checked list beats a long one with gaps.

## Step 3: Write / update PR description

Check if a PR exists:
```bash
BRANCH=$(git branch --show-current)
curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls?head=quantified-uncertainty:$BRANCH&state=open"
```

Write or update the PR body using the template from the checklist's "PR Description" section. Use `jq` for safe JSON construction:
```bash
PR_NUMBER=<number>
curl -s -X PATCH -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls/${PR_NUMBER}" \
  -d "$(jq -n --arg b "$BODY" '{body: $b}')"
```

The PR description must include:
- **Summary**: 2-5 bullet points (what and why)
- **Key changes**: 1-line per significant file/module
- **New pages/dashboards**: Routes listed (e.g., `/internal/facts`, `/wiki/E814`) — omit if none
- **Deployment notes**: Manual steps needed after merge — omit if none
- **GitHub issues**: Closes/references, new issues filed — omit if none
- **Test plan**: Verified checklist with all items checked and true

## Step 4: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 5: Session log

Create `.claude/sessions/YYYY-MM-DD_<branch-suffix>.md` per `.claude/rules/session-logging.md`.

## Step 6: Ship

Run `/push-and-ensure-green`.

## Step 7: Final report

Output a summary:

### Checklist
Show the final state of `.claude/wip-checklist.md`. All items must be checked or removed.

### Issues Found & Fixed
Problems caught during finalization that were fixed.

### Follow-up Issues Filed
GitHub issues created (numbers + titles).

### Verdict
- **SHIP IT**: All items checked, CI green, PR polished.
- **NEEDS WORK**: List unchecked items and blockers.

# Agent Session Ready PR

Verify the agent checklist is complete, polish the PR, and ship.

This command assumes `/agent-session-start` was run earlier and `.claude/wip-checklist.md` exists.

## Step 1: Check progress

Run `pnpm crux agent-checklist status` to see what remains.

If `.claude/wip-checklist.md` doesn't exist, generate one now with `pnpm crux agent-checklist init "Task description" --type=X` and work through ALL items before proceeding.

## Step 2: Build + test verification (MANDATORY)

Run these before anything else — a PR that doesn't build is not worth reviewing:

1. **`pnpm build`** — must exit 0. If it fails, fix the issue before proceeding.
2. **`pnpm test`** — existing tests must pass. If you added new logic (helpers, utilities, transformations), write tests for it.
3. **Gate check** (if MDX/YAML/validation changed): `pnpm crux validate gate --fix`

See `.claude/rules/pre-pr-verification.md` for full details on when tests are required.

## Step 2b: PR size check (MANDATORY — runs before completing checklist)

Check whether this PR exceeds the review thresholds:

```bash
git diff --stat main...HEAD
```

Parse the summary line (e.g. `12 files changed, 450 insertions(+), 120 deletions(-)`):
- **Files changed** = number before "files changed"
- **Lines changed** = insertions + deletions

**Check if `/review-pr` was run** by testing for the marker file and validating the commit SHA:

```bash
if [ -f .claude/review-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/review-done)
  HEAD_SHA=$(git rev-parse HEAD)
  if [ "$MARKER_SHA" = "$HEAD_SHA" ]; then
    echo "REVIEWED (SHA matches HEAD)"
  else
    echo "STALE (marker SHA ${MARKER_SHA:0:8} != HEAD ${HEAD_SHA:0:8})"
  fi
else
  echo "NOT_REVIEWED"
fi
```

**If thresholds exceeded (>5 files OR >300 lines) AND review marker is missing or stale:**

Print this warning prominently:

```
╔══════════════════════════════════════════════════════════════════════╗
║  REQUIRED: Large PR must be reviewed via /review-pr                 ║
║                                                                      ║
║  This PR exceeds size thresholds (>5 files or >300 lines) and       ║
║  /review-pr was not run (or was run before additional commits).     ║
║                                                                      ║
║  Per CLAUDE.md: "For non-trivial changes (>5 files or >300 lines),  ║
║  run /review-pr before shipping."                                   ║
║                                                                      ║
║  Running /review-pr now...                                           ║
╚══════════════════════════════════════════════════════════════════════╝
```

Then **run `/review-pr` automatically**. Do not offer an option to skip. The review is mandatory for PRs that exceed the thresholds.

If the thresholds are NOT exceeded, or if the review marker is valid (SHA matches HEAD), continue without interruption.

## Step 3: Complete unchecked items

For each unchecked item in the checklist:

1. **Can it be completed now?** Do it and check it off.
2. **Not applicable?** Mark with `[~]` in the checklist.
3. **Blocked?** Note why next to the item.

Pay special attention to:
- **Paranoid review** (`paranoid-review`): Run `/review-pr` — this handles diff review (fresh subagent), test plan validation, execution-based verification, and edge case testing. Fix or document every finding before checking the item off.
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims.

## Step 4: Write / update PR description

Check if a PR exists using `pnpm crux pr detect` and update it with: summary, key changes, test plan, issue references. If no PR exists yet, `/push-and-ensure-green` will create one using `crux pr create`.

## Step 4b: Consider post-merge verification

If this PR changes CI, Vercel config, GitHub Actions, scheduled workflows, or other infrastructure whose effect **cannot be verified by build + test alone**, add an entry to `.claude/audits.yaml`:

- Add a `post_merge` item with the PR number, what to verify, how to verify it, and a deadline (typically 1-2 weeks after merge)
- If the property should be checked permanently, add it as an ongoing audit item in the `audits` section instead

Skip this step if the PR only changes code, content, or styling that is fully verified by CI.

## Step 5: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 6: Session log

Run `pnpm crux agent-checklist snapshot` and capture the output — this is the `checks:` block for the session log.

Session logs are stored in the wiki-server PostgreSQL database (not committed to git). The checklist state is automatically synced to the DB when you use the `crux agent-checklist` commands. If no checklist was initialized, the snapshot will output `checks: {initialized: false}` — include that honestly in any session summaries.

**Record review status**: Check for the marker file, verify the SHA matches HEAD, and set the `reviewed` field in the session log payload accordingly:

```bash
# Returns "true" if reviewed with matching SHA, "false" otherwise
if [ -f .claude/review-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/review-done)
  HEAD_SHA=$(git rev-parse HEAD)
  [ "$MARKER_SHA" = "$HEAD_SHA" ] && echo "true" || echo "false"
else
  echo "false"
fi
```

Include `reviewed: true` or `reviewed: false` in the session log payload sent to the wiki-server. This enables the `/internal/agent-sessions` dashboard to show review coverage over time.

## Step 7: Validate completion

Run `pnpm crux agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 8: Ship

Run `/push-and-ensure-green`.

## Step 9: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

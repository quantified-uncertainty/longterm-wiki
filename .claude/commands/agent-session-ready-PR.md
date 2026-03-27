# Agent Session Ready PR

Verify the agent checklist is complete, polish the PR, and ship.

This command assumes `/agent-session-start` was run earlier and `.claude/wip-checklist.md` exists.

## Step 1: Check progress

Run `pnpm crux sys agent-checklist status` to see what remains.

If `.claude/wip-checklist.md` doesn't exist, generate one now with `pnpm crux sys agent-checklist init "Task description" --type=X` and work through ALL items before proceeding.

## Step 2: Build + test verification (MANDATORY)

Run these before anything else — a PR that doesn't build is not worth reviewing:

1. **`pnpm build`** — must exit 0. If it fails, fix the issue before proceeding.
2. **`pnpm test`** — existing tests must pass. If you added new logic (helpers, utilities, transformations), write tests for it.
3. **Gate check** (if MDX/YAML/validation changed): `pnpm crux w validate gate --fix`

See `.claude/rules/pre-pr-verification.md` for full details on when tests are required.

## Step 2b: PR size check (MANDATORY — runs before completing checklist)

Check whether this PR exceeds the review thresholds:

```bash
git diff --stat main...HEAD
```

Parse the summary line (e.g. `12 files changed, 450 insertions(+), 120 deletions(-)`):
- **Files changed** = number before "files changed"
- **Lines changed** = insertions + deletions

**Check if `/review-pr` was run** by testing for the marker file, validating the commit SHA, and verifying the diff hash:

```bash
if [ -f .claude/review-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/review-done)
  MARKER_HASH=$(awk '{print $4}' .claude/review-done)
  HEAD_SHA=$(git rev-parse HEAD)
  CURRENT_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
  if [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -n "$MARKER_HASH" ] && [ "$MARKER_HASH" = "$CURRENT_HASH" ]; then
    echo "REVIEWED (SHA + diff hash match)"
  elif [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -z "$MARKER_HASH" ]; then
    echo "STALE_FORMAT (missing diff hash — re-run /review-pr)"
  elif [ "$MARKER_SHA" != "$HEAD_SHA" ]; then
    echo "STALE (marker SHA ${MARKER_SHA:0:8} != HEAD ${HEAD_SHA:0:8})"
  else
    echo "STALE (diff hash mismatch)"
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

Check if a PR exists using `pnpm crux gh pr detect` and update it with: summary, key changes, test plan, issue references. If no PR exists yet, `/push-and-ensure-green` will create one using `crux gh pr create`.

## Step 4b: Deploy task detection and injection (MANDATORY)

Run the deploy task detector to check if this PR has post-deploy requirements:

```bash
pnpm crux gh deploy-tasks detect
```

If tasks are detected, inject the deploy checklist into the PR description:

```bash
pnpm crux gh deploy-tasks inject --pr=<PR_NUMBER>
```

If no PR exists yet, the inject command without `--pr` outputs the section — include it when creating the PR body.

This is **automatic** and **deterministic** — the detector scans the diff for migrations, env vars, workflow changes, schema changes, Docker changes, etc. You do not need to manually remember which changes need post-deploy verification.

For infrastructure changes that the detector does **not** cover (DNS changes, external service configuration, manual database operations), also add a `post_merge` entry to `.claude/audits.yaml` with the PR number, what to verify, and a deadline.

## Step 5: Update GitHub issue

If working on a GitHub issue:
```bash
pnpm crux gh issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Step 6: Session log

Run `pnpm crux sys agent-checklist snapshot` and capture the output — this is the `checks:` block for the session log.

Session logs are stored in the wiki-server PostgreSQL database (not committed to git). The checklist state is automatically synced to the DB when you use the `crux sys agent-checklist` commands. If no checklist was initialized, the snapshot will output `checks: {initialized: false}` — include that honestly in any session summaries.

**Record review status**: Check for the marker file, verify both the SHA and diff hash match, and set the `reviewed` field in the session log payload accordingly:

```bash
# Returns "true" only if SHA matches HEAD AND diff hash matches current diff
if [ -f .claude/review-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/review-done)
  MARKER_HASH=$(awk '{print $4}' .claude/review-done)
  HEAD_SHA=$(git rev-parse HEAD)
  CURRENT_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
  if [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -n "$MARKER_HASH" ] && [ "$MARKER_HASH" = "$CURRENT_HASH" ]; then
    echo "true"
  else
    echo "false"
  fi
else
  echo "false"
fi
```

Include `reviewed: true` or `reviewed: false` in the session log payload sent to the wiki-server. This enables the `/internal/agent-sessions` dashboard to show review coverage over time. A marker without a diff hash (legacy format) is treated as `reviewed: false`.

## Step 7: Validate completion

Run `pnpm crux sys agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 8: Ship

Run `/push-and-ensure-green`.

## Step 9: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

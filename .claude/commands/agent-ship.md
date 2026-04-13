---
description: Verify the agent checklist is complete, polish the PR, and ship. For sessions without a PR, use /agent-end instead.
effort: medium
---

# Agent Ship — Build, Review, Push, and Close

Verify the agent checklist is complete, polish the PR, and ship. Includes session close-out (what `/agent-end` does standalone).

**If this session doesn't have code to ship** (research, abandoned, maintenance), use `/agent-end` instead — it's the lightweight close without the build/review/push steps.

This command assumes `/agent-init` was run earlier and `.claude/wip-checklist.md` exists.

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

**Check if `/agent-review-pr` was run** by testing for the marker file, validating the commit SHA, and verifying the diff hash:

```bash
if [ -f .claude/review-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/review-done)
  MARKER_HASH=$(awk '{print $4}' .claude/review-done)
  HEAD_SHA=$(git rev-parse HEAD)
  CURRENT_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
  if [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -n "$MARKER_HASH" ] && [ "$MARKER_HASH" = "$CURRENT_HASH" ]; then
    echo "REVIEWED (SHA + diff hash match)"
  elif [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -z "$MARKER_HASH" ]; then
    echo "STALE_FORMAT (missing diff hash — re-run /agent-review-pr)"
  elif [ "$MARKER_SHA" != "$HEAD_SHA" ]; then
    echo "STALE (marker SHA ${MARKER_SHA:0:8} != HEAD ${HEAD_SHA:0:8})"
  else
    echo "STALE (diff hash mismatch)"
  fi
else
  echo "NOT_REVIEWED"
fi
```

**If review marker is missing or stale, run `/agent-review-pr`:**

`/agent-review-pr` is now adaptive — it triages the diff and scales its verification intensity to the PR size and risk. Even small PRs benefit from a quick review (build + types + tests + gate + diff review). Large or risky PRs get the full treatment (red-teaming, Playwright testing, test coverage audit, simplification).

Print this message and run the review:

```
═══════════════════════════════════════════════════════════════
  Running /agent-review-pr (adaptive — intensity scales to PR size)
  [N] files changed, [M] lines
═══════════════════════════════════════════════════════════════
```

**Do not offer an option to skip.** The review is mandatory for all code PRs. The triage phase handles scaling — a 5-line fix gets a 2-minute review, a 500-line feature gets the full treatment.

**Content-only PRs** (only `.mdx`/`.yaml` changes, no code logic): The review triage will detect this and run only the gate check + content validation. This is fast and still mandatory.

If the review marker is valid (SHA + diff hash match HEAD), continue without re-running.

### Simplify marker check (PRs with ≥200 lines changed)

`/agent-review-pr` does one simplification pass as part of its adaptive plan. For larger PRs, a dedicated `/simplify` pass is still required — otherwise a token "simplification" slipped into review fixes can satisfy the review marker without a real pass. Enforce this only when the diff is big enough to make a second pass worthwhile.

Reuse the lines-changed count from the top of Step 2b. If `lines changed < 200`, print `Simplify: skipped (PR below 200-line threshold)` and continue. Otherwise check the marker the same way as review-done:

```bash
if [ -f .claude/simplify-done ]; then
  MARKER_SHA=$(awk '{print $2}' .claude/simplify-done)
  MARKER_HASH=$(awk '{print $4}' .claude/simplify-done)
  HEAD_SHA=$(git rev-parse HEAD)
  CURRENT_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
  if [ "$MARKER_SHA" = "$HEAD_SHA" ] && [ -n "$MARKER_HASH" ] && [ "$MARKER_HASH" = "$CURRENT_HASH" ]; then
    echo "SIMPLIFIED (SHA + diff hash match)"
  elif [ "$MARKER_SHA" != "$HEAD_SHA" ]; then
    echo "STALE (marker SHA ${MARKER_SHA:0:8} != HEAD ${HEAD_SHA:0:8}) — re-run /simplify"
  else
    echo "STALE (diff hash mismatch) — re-run /simplify"
  fi
else
  echo "NOT_SIMPLIFIED — run /simplify before /agent-ship"
fi
```

**If the marker is missing or stale, stop and run `/simplify`.** Do not ship without it. After `/simplify` completes and any resulting changes are committed, write the marker against the final state:

```bash
DIFF_HASH=$(git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)...HEAD | shasum -a 256 | cut -c1-12)
echo "simplified $(git rev-parse HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) ${DIFF_HASH}" >| .claude/simplify-done
```

The `simplify` skill is a system skill and cannot be edited from this repo, so the marker must be written by hand after running it. Below the 200-line threshold the marker is optional; at or above it, it is required to ship. Rationale for 200 (vs. the gate's 300-line review threshold): `/simplify` is cheaper than `/agent-review-pr` and earlier enforcement catches mid-sized PRs before they grow.

## Step 3: Complete unchecked items

For each unchecked item in the checklist:

1. **Can it be completed now?** Do it and check it off.
2. **Not applicable?** Mark with `[~]` in the checklist.
3. **Blocked?** Note why next to the item.

Pay special attention to:
- **Review** (`paranoid-review`): Run `/agent-review-pr` — this triages the diff, builds an adaptive verification plan (diff review, simplification, test coverage, red-teaming, UI/API/CLI testing as applicable), and executes it. Fix or document every finding before checking the item off.
- **Self-audit**: Re-run commands you claimed to run. Verify outputs match your claims.

## Step 4: Write / update PR description

Check if a PR exists using `pnpm crux gh pr detect` and update it with: summary, key changes, test plan, issue references. If no PR exists yet, `/agent-push-and-verify` will create one using `crux gh pr create`.

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

### MANDATORY: review the auto-detected list, augment for anything specific to this PR

Auto-detection is a **floor, not a ceiling.** Read every task in the `<!-- deploy-tasks:v1 -->` block out loud and ask: "If a fresh agent or human read only this checklist after merge, would they actually validate that this PR works end to end?" If the answer is no, add an explicit manual line **inside the marker block** so `crux gh deploy-tasks pending` picks it up.

Common gaps the auto-detector misses (add manual lines for these — there is no exhaustive list, use judgment):

- **New scheduled workflows on a long cron** (weekly, monthly): the auto-detector adds a "verify it ran" line, but you'll be waiting 5+ days for the cron to fire. Add a manual `gh workflow run <file>.yml` trigger as a separate item, framed as "do not wait for the schedule."
- **New CLI commands or flags**: auto-detection notices the file change but not "run the new flag once on real prod data and confirm output is what you said it would be."
- **New API endpoints**: auto-detected, but verify they're discoverable from where you intended (linked from a dashboard, sidebar, navigation, etc.) — the detector only checks `curl -sf`.
- **New external integrations** (Discord, Slack, Linear comments, webhooks): the auto-detector does not know about secret wiring. If your PR depends on a secret being set in GitHub Actions, add a manual line to verify the first run actually used it. Best-effort fire-and-forget code paths silently skip when keys are missing.
- **New dashboards or internal pages**: render-audit will catch broken pages but not "the data on this page is the data you intended" — add a manual sanity-check line.
- **Anything the ticket said "validate manually first"**: copy that requirement into the deploy checklist as a hard task, not just prose.

**The shape of a good manual deploy task:**
- Lives inside the `<!-- deploy-tasks:v1 -->` markers (otherwise `pending` won't track it)
- Starts with `- [ ] \`manual\`` so it's distinguishable from auto-generated entries
- States the action *and* the expected outcome ("trigger X, expect Y in place Z"), not just "verify X"
- Includes the exact command to run if applicable, after the em-dash, in backticks

For infrastructure changes that the detector does **not** cover (DNS changes, external service configuration, manual database operations), also add a `post_merge` entry to `.claude/audits.yaml` with the PR number, what to verify, and a deadline.

## Step 5: Update Linear issue (primary — if applicable)

**Linear is the primary issue tracker.** If this session was tracking a Linear issue, move it to In Review so the Linear backlog reflects the open PR. Set `PR_URL` to the PR created/updated in step 4 first:

```bash
# PR_URL must be set by the ship flow — it's the URL of the PR just pushed.
# /agent-push-and-verify sets it; if running this step manually, export first.
PR_URL="${PR_URL:-}"

# Pull the Linear ID from the checklist metadata (added by /agent-init when it
# auto-detects `claude/qua-NNN-*` branches or a QUA-NNN in the task description).
LINEAR_ID=$(grep -oE '^> Linear: [A-Z]+-[0-9]+' .claude/wip-checklist.md 2>/dev/null | awk '{print $3}')

if [ -n "$LINEAR_ID" ] && [ -n "$PR_URL" ]; then
  pnpm crux linear done "$LINEAR_ID" --pr="$PR_URL" || echo "⚠ Linear update failed — check LINEAR_API_KEY and rerun"
fi
```

Requires `LINEAR_API_KEY` (synced from `.env.base`). The `|| echo` keeps this best-effort so a missing key doesn't abort the ship flow. Linear → Done happens automatically when the PR merges, via Linear's native GitHub integration — **but only if** the branch name contains `qua-NNN` or the PR body contains `Fixes QUA-NNN`. `crux gh pr create` auto-injects the latter from the branch name, checklist metadata, and `--linear` flag.

## Step 5b: Update legacy GitHub issue (if applicable)

If working on a legacy GitHub issue (not a Linear issue):
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

Run `/agent-push-and-verify`.

## Step 9: Session close-out

Clean up session artifacts and discard any unstaged changes (modified hooks, deleted markers, etc.):

```bash
rm -f .claude/wip-checklist.md .claude/wip-context.md
git checkout -- .claude/review-done 2>/dev/null || rm -f .claude/review-done
git checkout -- .claude/simplify-done 2>/dev/null || rm -f .claude/simplify-done
git checkout -- .claude/hooks/ 2>/dev/null || true
```

## Step 10: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

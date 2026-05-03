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

1. **`pnpm build`** — must exit 0. Catches TypeScript errors, SSR rendering issues (missing `"use client"`, server/client boundary violations), import resolution failures, and MDX compilation errors across all 600+ pages. If too slow for the change scope, `pnpm build-data:content` + `npx tsc --noEmit` is acceptable for content-only or type-only changes.
2. **`pnpm test`** — existing tests must pass. Always write tests for new utility/helper functions, data transformation logic, validation rules, and CLI commands. Tests are optional for pure JSX layout, configuration, and CSS/styling changes.
3. **Gate check** (if MDX/YAML/validation changed): `pnpm crux w validate gate --fix`. If it fails with thousands of `resource-ref-integrity` errors on a branch you haven't touched resources on, build-data is seeing an incomplete resource set — refresh the snapshot via `WIKI_SERVER_ENV=prod pnpm crux sys wiki-server snapshot-resources`, or force the snapshot path with `LONGTERMWIKI_SERVER_URL= git push`.
4. **Playwright verification** (if `.tsx` pages or components changed): run e2e tests against prod before opening the PR, don't ask the user to manually check pages:
   ```bash
   cd apps/web && PLAYWRIGHT_BASE_URL=https://www.longtermwiki.com npx playwright test e2e/render-audit.spec.ts
   ```
   For specific tests, swap `e2e/render-audit.spec.ts` for the relevant spec (17 specs in `apps/web/e2e/`: directory-pages, entity-detail-pages, homepage, factbase, mobile-nav, header-dropdowns, etc.). For ad-hoc page checks, use `DEV_PORT=<slot-port> npx playwright test`. Display bug fixes should add a regression check to `e2e/render-audit.spec.ts`.
5. **Completeness check** — re-read the original issue and verify every acceptance criterion is met. Cite a specific file+line or test for each one. A PR that needs a follow-up PR to be functional is **incomplete** — split into independently-shippable pieces *before* starting work, not after. No "Part 1 of 3" PRs that break without Part 2.

If any verification fails: fix it before opening the PR. If you can't fix it, note the failure in the PR description and ask the user — do NOT open the PR claiming it works when it doesn't.

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

### Shell safety when writing PR bodies

**Never use `>` to write temp files** — zsh `noclobber` prevents overwriting and the heredoc fails silently with stale content. Use `>|` (force overwrite), `mktemp`, or pipe directly via heredoc stdin:

```bash
# GOOD: pipe directly
pnpm crux gh pr create --title="..." <<'PRBODY'
body here
PRBODY

# GOOD: force overwrite
cat >| /tmp/pr-body.md <<'PRBODY'
body here
PRBODY

# BAD: silently fails with noclobber, uses stale file content
cat > /tmp/pr-body.md <<'PRBODY'
body here
PRBODY
```

### GitHub issue auto-close syntax

Use **one `Closes #N` per line** in the PR body. A comma-separated list (`Closes #1, #2, #3`) is **not** reliably recognized — only the first issue closes.

```
Closes #529
Closes #530
Closes #533
```

For Linear, the PR auto-closes the issue if the branch contains `qua-NNN` OR the body contains `Fixes QUA-NNN` (auto-injected by `crux gh pr create`).

### Step 4a: Surface skipped review phases (QUA-950)

If `/agent-review-pr` ran with any phases skipped via `reason=...`, surface that in the PR body so reviewers can see the coverage trail without trusting the agent's summary alone.

`pnpm` prepends a multi-line prelude (`> longterm-wiki@...\n> DOTENV_CONFIG_QUIET=...`) to its child's stdout, which corrupts the snippet if you capture pnpm's output directly. Use `pnpm --silent` to suppress the prelude (or invoke `node` directly):

```bash
SKIPPED=$(pnpm --silent crux sys review-phase summary 2>/dev/null | sed '/^$/d')
if [ -n "$SKIPPED" ]; then
  printf '\n## Review Phases Skipped\n\n%s\n\nFull tracker: `.claude/review-phases-done` (gitignored, session-local).\n' "$SKIPPED"
fi
```

When every phase executed, `summary` outputs nothing and the section is omitted. Append the printed block to the PR body alongside the test plan.

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

## Step 4c: Post-merge verification — file Linear ticket or audits.yaml entry

When a PR changes infrastructure, CI config, Vercel settings, GitHub Actions, DNS, or any behavior that **cannot be verified by `pnpm build` + `pnpm test`**, decide where the post-merge verification lives:

- **One-time verification of infra/CI/DNS behavior** ("after this merges, check that X actually happened") → add a `post_merge` entry to `.claude/audits.yaml` with PR number, what to verify, and a deadline.
- **Ongoing property to monitor** (e.g. "scheduled workflows keep running") → add to `.claude/audits.yaml` `audits` section.
- **Flag/gate cleanup with a date, post-deploy verification needed, or anything "do this in N weeks"** → file a Linear ticket via `pnpm crux linear create`. PR patrol and the maintenance sweep surface it.

Run `pnpm crux sys audits list` to see current items.

### Do NOT offer to `/schedule` verification agents

The default Claude Code session-end behavior offers a `/schedule` of a background agent for natural follow-ups (post-merge verification, soak windows, flag cleanup, gate ramps). **In this project, do not make that offer.** A `/schedule` agent fires once into the void and produces no audit trail; a Linear ticket is visible to humans, dedup-able, prioritizable, and discoverable by the next coordinator session. Use Linear or `audits.yaml` instead. This rule overrides the generic Claude Code session-end guidance regardless of how natural the follow-up seems.

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

Session logs are stored in the wiki-server PostgreSQL database (not committed to git). `agent-checklist complete` (Step 7) syncs the local close-time fields it can know before push — `checksYaml` (from the WIP checklist) and `reviewed` (from the `.claude/review-done` marker). `agents close` (Step 9) then does the GitHub PR lookup and syncs `prUrl` too. Both paths best-effort attempt `status='completed'`, but the row may remain `active`/`stale` until the SessionEnd hook fires `session-finalize` to write `title`+`summary` (which then promotes status atomically). QUA-1073 — you no longer need to read the marker or capture the snapshot by hand.

If you want to inspect what will be sent, `pnpm crux sys agent-checklist snapshot --ci` prints the same JSON that gets serialized into `checksYaml` (the bare `snapshot` command formats as YAML for human reading; `--ci` is the machine-readable form). If no checklist was initialized, the snapshot outputs `{initialized: false}` — include that honestly in any session summaries.

## Step 7: Validate completion

Run `pnpm crux sys agent-checklist complete` — must exit 0 (all items checked or N/A).

## Step 8: Ship

Run `/agent-push-and-verify`.

## Step 9: Session close-out

Close the session in the active-agents registry so the row leaves `status=active` (otherwise the active_agents table accumulates phantoms — see QUA-584). `/agent-end` does this in its step 6; ship needs the same call:

```bash
pnpm crux sys agents close 2>/dev/null || true
```

Best-effort: if the wiki-server is unreachable, the scheduled active-agents sweep will catch it within an hour.

Then clean up session artifacts and discard any unstaged changes (modified hooks, deleted markers, etc.):

```bash
rm -f .claude/wip-checklist.md .claude/wip-context.md
git checkout -- .claude/review-done 2>/dev/null || rm -f .claude/review-done
git checkout -- .claude/review-phases-done 2>/dev/null || rm -f .claude/review-phases-done
git checkout -- .claude/simplify-done 2>/dev/null || rm -f .claude/simplify-done
git checkout -- .claude/hooks/ 2>/dev/null || true
```

## Step 10: Final report

Output a summary with: checklist final state, issues found & fixed, follow-up issues filed, and verdict (SHIP IT or NEEDS WORK).

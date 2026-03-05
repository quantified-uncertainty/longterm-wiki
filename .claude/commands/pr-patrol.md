# PR Patrol

Scan all open PRs for issues and fix them in priority order. One-shot version of the `scripts/pr-patrol.sh` daemon.

**When to use:** Periodically, or when you want to clean up the PR backlog. It can also be run as a daemon via `scripts/pr-patrol.sh`.

## Phase 1: Scan all open PRs

Fetch all open PRs and detect issues:

```bash
gh pr list --repo quantified-uncertainty/longterm-wiki --state open --limit 50 \
  --json number,title,headRefName,mergeable,statusCheckRollup,updatedAt,body,labels
```

For each PR, check:

| Issue | Detection | Priority |
|-------|-----------|----------|
| **Merge conflict** | `mergeable == "CONFLICTING"` | P0 (score: 100) |
| **CI failure** | `statusCheckRollup` has `FAILURE` conclusion | P1 (score: 80) |
| **Bot review (major)** | Unresolved Major/Minor/Critical bot comment (CodeRabbit etc.) | P2 (score: 55) |
| **Missing issue reference** | PR body lacks `Closes #N` / `Fixes #N` | P2 (score: 40) |
| **Stale** (>48h no update) | `updatedAt` comparison | P3 (score: 30) |
| **Missing test plan** | PR body lacks `## Test plan` section | P3 (score: 20) |
| **Bot review (nitpick)** | Unresolved nitpick-only bot comments | P3 (score: 15) |

**Skip PRs with the `claude-working` label** — another session is already on them.

## Phase 2: Prioritize

Score each PR by summing the scores of its detected issues. Sort descending. Display the full queue:

```text
Priority queue (N items):
  [score=180] PR #123: conflict,ci-failure — Fix authentication flow
  [score=40]  PR #456: missing-issue-ref — Update entity types
```

## Phase 3: Fix (one PR at a time)

Work through the queue starting with the highest-priority PR:

### Merge conflicts
1. Check out the PR branch: `git checkout <branch>`
2. Rebase on main: `git rebase origin/main`
3. Resolve conflicts — prefer the PR's changes where intent is clear
4. For generated files (database.json, lock files), regenerate: `pnpm build-data:content`
5. `git rebase --continue` then `git push --force-with-lease`

### CI failures
1. Check what failed: `gh pr checks <N>`
2. Read CI logs to understand the failure
3. Fix the issue locally, verify with `pnpm build` / `pnpm test`
4. Commit and push

### Bot review comments (CodeRabbit etc.)
1. Bot comment details are included directly in the fix prompt (fetched via GraphQL `reviewThreads`)
2. For Major/Minor/Critical issues: verify the concern is valid, then fix
3. For Nitpick issues: fix only if trivial and clearly correct
4. Look for "Prompt for AI Agents" sections — they contain ready-made fix instructions
5. Commit and push

### Missing test plan
1. Read the PR diff to understand what changed
2. Add a `## Test plan` section to the PR body via `gh pr edit`

### Missing issue reference
1. Search for related issues: `gh issue list --search "keywords"`
2. If a match exists, add `Closes #N` to the PR body
3. If no match, skip — not all PRs need an issue

### Stale PRs
1. Rebase on main to pick up latest changes
2. Push to re-trigger CI

## Phase 4: Report

After processing, summarize:
- How many PRs were scanned
- What issues were found and fixed
- What's still in the queue (if any)

## Guardrails

- **One PR at a time.** Finish one fix before starting the next.
- **Only fix detected issues.** Don't refactor or improve unrelated code on the PR's branch.
- **Use `--force-with-lease`** not `--force` when pushing rebased branches.
- **Don't dismiss reviews.** Fix the requested changes and let the reviewer re-approve.
- **If a conflict is too complex**, note it and move to the next PR.
- **Run `pnpm crux validate gate --fix`** after any code changes.

## Daemon mode

For continuous monitoring, use the crux command:

```bash
pnpm crux pr-patrol run                   # 5-min interval, continuous
pnpm crux pr-patrol once                  # Single pass
pnpm crux pr-patrol once --dry-run        # Preview only
pnpm crux pr-patrol run --interval=120    # Custom interval
pnpm crux pr-patrol status                # Show recent activity
```

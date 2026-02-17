# Ship

Run all CI checks locally, push to GitHub, and monitor until green. Fix and retry if anything fails.

## Step 0: Pre-flight

1. Run `git fetch origin` to ensure remote refs are up to date.
2. Check if the current branch is behind the remote (`git status -b --short`). If behind, warn the user — they may need to pull/rebase before pushing.

## Step 1: Run all local checks (be paranoid)

Run `pnpm crux validate gate --fix` (auto-fixes escaping/markdown, then runs all CI-blocking checks including TypeScript). If you also want the full Next.js build, use `--full`.

### Handling failures

**New failures** (caused by your changes): Stop and fix. Re-run the failing check, then re-run ALL checks to make sure fixes didn't break something else.

**Pre-existing failures** (also present on clean main, not caused by your changes): To determine if a failure is pre-existing, stash your changes and re-run the failing check on clean main. If it fails the same way, it's pre-existing — note it and move on. Do not block the push on pre-existing failures.

### Build artifacts

`pnpm build` may modify files like `src/data/stats.json` as a side effect. These build artifact changes should be included in the commit if they show up in `git status` after running checks.

## Step 2: Push to GitHub

1. Check `git status` for uncommitted changes. If there are any, ask the user what to do (commit, stash, etc.) — do NOT auto-commit without asking.
2. **NEVER push directly to main.** If on `main`, stop and warn the user: "You are on the main branch. Create a feature branch first." Do not proceed.
3. If on a feature branch:
   - Push with `git push -u origin HEAD`.
   - Check if a PR already exists:
     ```bash
     BRANCH=$(git branch --show-current)
     curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
       "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls?head=quantified-uncertainty:$BRANCH&state=open"
     ```
   - If no PR exists (empty array), create one:
     ```bash
     curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
       "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/pulls" \
       -d "{\"title\": \"<descriptive title>\", \"head\": \"$BRANCH\", \"base\": \"main\", \"body\": \"<summary>\"}"
     ```
   - If a PR exists, note its number and move on.

## Step 3: Verify GitHub is green

1. Wait 15 seconds for checks to register, then run `pnpm crux ci status --wait` to poll until all checks complete.
   If the `crux ci status` command is not available, fall back to manual polling:
   ```bash
   SHA=$(git rev-parse HEAD)
   curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/commits/$SHA/check-runs" \
     | python3 -c "
   import sys, json; data = json.load(sys.stdin)
   all_done = True; any_failed = False
   for r in data.get('check_runs', []):
       status, conclusion = r['status'], r.get('conclusion') or '(pending)'
       print(f\"  {r['name']:40s} {status:12s} {conclusion}\")
       if status != 'completed': all_done = False
       if conclusion == 'failure': any_failed = True
   print(f\"Total: {data['total_count']} checks\")
   print(f\"All done: {all_done}, Any failed: {any_failed}\")
   "
   ```
2. Re-check every 30 seconds until all checks are `completed`.
3. **CRITICAL**: ALL check runs must show `conclusion: success`. Do NOT trust workflow-level conclusion alone — `continue-on-error: true` makes the workflow pass but individual check runs can still show as failed.
4. Report the final status of each check run to the user.

## Step 4: Handle failures

If any GitHub CI **check run** has `conclusion: failure`:

1. Get the failed run's logs. Find the workflow run ID and download logs:
   ```bash
   # List recent workflow runs for the branch
   BRANCH=$(git branch --show-current)
   curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/quantified-uncertainty/longterm-wiki/actions/runs?branch=$BRANCH&per_page=1" \
     | python3 -c "
   import sys, json; data = json.load(sys.stdin)
   for run in data.get('workflow_runs', []):
       print(f\"Run {run['id']}: {run['name']} — {run['status']} / {run.get('conclusion', 'pending')}\")
       print(f\"  Logs: {run['logs_url']}\")
   "
   ```
2. Analyze the failure and fix the underlying issue.
3. Go back to **Step 1** and repeat the full cycle.

If all check runs show **success**: Report success. Include the PR URL if on a feature branch, or confirm the push is green on main.

## Guardrails

- Maximum 3 full retry cycles. If still failing after 3 attempts, stop and report what's wrong so the user can decide how to proceed.
- Never force-push unless explicitly asked.
- Never skip pre-commit hooks.
- Always show the user what failed and what you're fixing before making changes.

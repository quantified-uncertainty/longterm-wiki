# Push Safe

Run all CI checks locally, push to GitHub, and monitor until green. Fix and retry if anything fails.

## Step 0: Pre-flight

1. Run `git fetch origin` to ensure remote refs are up to date.
2. Check if the current branch is behind the remote (`git status -b --short`). If behind, warn the user — they may need to pull/rebase before pushing.

## Step 1: Run all local checks (be paranoid)

Run ALL of the following checks. Run them in parallel where possible:

- `pnpm build` (includes build-data)
- `pnpm test`
- `node tooling/crux.mjs validate`
- `pnpm lint` (if it exists)
- TypeScript type checking via `cd app && pnpm tsc --noEmit` (if tsconfig exists)

### Handling failures

**New failures** (caused by your changes): Stop and fix. Re-run the failing check, then re-run ALL checks to make sure fixes didn't break something else.

**Pre-existing failures** (also present on clean main, not caused by your changes): To determine if a failure is pre-existing, stash your changes and re-run the failing check on clean main. If it fails the same way, it's pre-existing — note it and move on. Do not block the push on pre-existing failures.

### Build artifacts

`pnpm build` may modify files like `src/data/stats.json` as a side effect. These build artifact changes should be included in the commit if they show up in `git status` after running checks.

## Step 2: Push to GitHub

1. Check `git status` for uncommitted changes. If there are any, ask the user what to do (commit, stash, etc.) — do NOT auto-commit without asking.
2. If on `main`: push directly with `git push origin main`.
3. If on a feature branch:
   - Push with `git push -u origin HEAD`.
   - Check if a PR exists: `gh pr view --json number 2>/dev/null`
   - If no PR exists, create one with `gh pr create` using a descriptive title and summary.
   - If a PR exists, note its number and move on.

## Step 3: Verify GitHub is green

1. Wait 15 seconds for checks to register, then poll CI status using `gh run list --branch <branch> --limit 1`.
2. Re-check every 30 seconds until the run completes.
3. **CRITICAL**: After the run completes, verify the **actual check-run conclusions** on the commit using:
   ```
   gh api repos/{owner}/{repo}/commits/{sha}/check-runs --jq '.check_runs[] | {name, conclusion, status}'
   ```
   Do NOT trust `gh run view` conclusion alone — `continue-on-error: true` makes the workflow pass but individual check runs can still show as failed (red X on GitHub).
4. ALL check runs must show `conclusion: success`. If any show `failure`, treat it as a CI failure.
5. Report the final status of each check run to the user.

## Step 4: Handle failures

If any GitHub CI **check run** has `conclusion: failure`:

1. Get the failed check's logs: `gh run view <run-id> --log-failed`
2. Analyze the failure and fix the underlying issue.
3. Go back to **Step 1** and repeat the full cycle.

If all check runs show **success**: Report success. Include the PR URL if on a feature branch, or confirm the push is green on main.

## Guardrails

- Maximum 3 full retry cycles. If still failing after 3 attempts, stop and report what's wrong so the user can decide how to proceed.
- Never force-push unless explicitly asked.
- Never skip pre-commit hooks.
- Always show the user what failed and what you're fixing before making changes.

# Ship

Run all CI checks locally, push to GitHub, and monitor until green. Fix and retry if anything fails.

## Step 0: Pre-flight

1. Run `git fetch origin` to ensure remote refs are up to date.
2. Check the branch status: `git status -b --short`
3. Handle the result based on ahead/behind counts:
   - **Only ahead** (e.g. `[ahead 3]`): Normal — proceed to Step 1.
   - **Only behind** (e.g. `[behind 5]`): Run `git pull --rebase` to incorporate remote changes, then proceed.
   - **Both ahead and behind** (e.g. `[ahead 3, behind 23]`): The auto-rebase GitHub Actions workflow has already rebased the remote branch onto main, but the local copy is stale. Run `git pull --rebase` to rebase local commits on top of the updated remote. If conflicts arise, run `git rebase --abort`, report conflicts to the user, and stop.
   - After any `git pull --rebase`, re-run `git status -b --short` to confirm the branch is only ahead (or up to date) before continuing.

**Why "ahead N, behind M" happens:** When the auto-rebase workflow runs after another PR merges to main, it rebases this branch's commits on the remote and force-pushes. The local session hasn't pulled those changes yet, so it appears ahead (local commits) and behind (rebased remote commits).

## Step 1: Run all local checks (be paranoid)

Run `pnpm crux validate gate --fix` (auto-fixes escaping/markdown, then runs all CI-blocking checks including TypeScript). The gate auto-escalates to include the full Next.js build when app page components or prerendered data files are in the diff. You can also force it with `--full`.

### Handling failures

**New failures** (caused by your changes): Stop and fix. Re-run the failing check, then re-run ALL checks to make sure fixes didn't break something else.

**Pre-existing failures** (also present on clean main, not caused by your changes): To determine if a failure is pre-existing, stash your changes and re-run the failing check on clean main. If it fails the same way, it's pre-existing — note it and move on. Do not block the push on pre-existing failures.

### Build artifacts

`pnpm build` may modify files like `src/data/stats.json` as a side effect. These build artifact changes should be included in the commit if they show up in `git status` after running checks.

## Step 2: Push to GitHub

1. Check `git status` for uncommitted changes. If there are any, ask the user what to do (commit, stash, etc.) — do NOT auto-commit without asking.
2. **NEVER push directly to main.** If on `main`, stop and warn the user: "You are on the main branch. Create a feature branch first." Do not proceed.
3. If on a feature branch:
   - If you ran `git pull --rebase` in Step 0 (branch was diverged), push with `git push --force-with-lease -u origin HEAD` since the history was rewritten by the rebase.
   - Otherwise push normally with `git push -u origin HEAD`.
   - Check if a PR already exists using crux:
     ```bash
     pnpm crux pr detect
     ```
   - If no PR exists (exit code 1), create one using crux:
     ```bash
     pnpm crux pr create --title="<descriptive title>" --body="## Summary

     - <key change 1>
     - <key change 2>

     ## Test plan
     - [ ] <test step>"
     ```
     **After creating, always run `pnpm crux pr fix-body`** — this detects and repairs any literal `\n` in the PR body automatically.
   - If a PR exists, note its number and move on.

**IMPORTANT:** Always use `crux pr create` and `crux pr detect` instead of raw curl commands. The crux commands route through `githubApi()` which validates request bodies for shell-expansion corruption (ANSI codes, dotenv output, etc.) before sending to GitHub.

## Step 3: Verify GitHub is green

1. Wait 15 seconds for checks to register, then run `pnpm crux ci status --wait` to poll until all checks complete.
2. **CRITICAL**: ALL check runs must show `conclusion: success`. Do NOT trust workflow-level conclusion alone — `continue-on-error: true` makes the workflow pass but individual check runs can still show as failed.
3. Report the final status of each check run to the user.

## Step 4: Handle failures

If any GitHub CI **check run** has `conclusion: failure`:

1. Get the failed run's logs:
   ```bash
   gh run list --branch "$(git branch --show-current)" --limit 1
   gh run view <RUN_ID> --log-failed
   ```
2. Analyze the failure and fix the underlying issue.
3. Go back to **Step 1** and repeat the full cycle.

If all check runs show **success**: Report success. Include the PR URL if on a feature branch, or confirm the push is green on main.

## Guardrails

- Maximum 3 full retry cycles. If still failing after 3 attempts, stop and report what's wrong so the user can decide how to proceed.
- Never force-push unless explicitly asked, **except** after a `git pull --rebase` in Step 0 (where `--force-with-lease` is required and safe because the rebase rewrote local history to match the remote's rebased history).
- Never skip pre-commit hooks.
- Always show the user what failed and what you're fixing before making changes.

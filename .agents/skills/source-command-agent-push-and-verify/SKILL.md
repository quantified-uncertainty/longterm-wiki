---
name: "source-command-agent-push-and-verify"
description: "Run CI checks locally, push to GitHub, monitor until CI green AND PR mergeable. Fix and retry if anything fails."
---

# source-command-agent-push-and-verify

Use this skill when the user asks to run the migrated source command `agent-push-and-verify`.

## Command Template

# Ship

Run all CI checks locally, push to GitHub, and monitor until CI is green AND the PR is mergeable. Fix and retry if anything fails.

## Step 0: Pre-flight

1. Run `git fetch origin` to ensure remote refs are up to date.
2. Check the branch status: `git status -b --short`
3. Handle the result based on ahead/behind counts:
   - **Only ahead** (e.g. `[ahead 3]`): Normal — proceed to Step 1.
   - **Only behind** (e.g. `[behind 5]`): Run `git pull --rebase` to incorporate remote changes, then proceed.
   - **Both ahead and behind** (e.g. `[ahead 3, behind 23]`): The auto-rebase GitHub Actions workflow has already rebased the remote branch onto main, but the local copy is stale. Run `git pull --rebase` to rebase local commits on top of the updated remote. If conflicts arise, run `git rebase --abort`, report conflicts to the user, and stop.
   - After any `git pull --rebase`, re-run `git status -b --short` to confirm the branch is only ahead (or up to date) before continuing.

**Why "ahead N, behind M" happens:** When the auto-rebase workflow runs after another PR merges to main, it rebases this branch's commits on the remote and force-pushes. The local session hasn't pulled those changes yet, so it appears ahead (local commits) and behind (rebased remote commits).

### Merge-conflict pre-check (MANDATORY)

After the branch is synced with its remote, verify it can merge cleanly into current `origin/main`:

```bash
git merge-tree --write-tree HEAD origin/main > /dev/null 2>&1
```

- **Exit 0** (clean merge): Proceed to Step 1.
- **Non-zero** (conflicts): The branch conflicts with current main. Rebase onto `origin/main`:
  ```bash
  git rebase origin/main
  ```
  - If rebase succeeds: proceed to Step 1 (local checks must re-run against the rebased code). Step 2 will push with `--force-with-lease` since the rebase rewrote history.
  - If rebase has conflicts: run `git rebase --abort`, report the conflicting files to the user, and **stop**. Do not push a branch with known merge conflicts.

**Why this matters:** Without this check, local tests pass against stale code, the push succeeds, but the PR shows "has conflicts" on GitHub — wasting a CI cycle and requiring a manual rebase later.

## Step 1: Run all local checks (be paranoid)

Run `pnpm crux w validate gate --fix` (auto-fixes escaping/markdown, then runs all CI-blocking checks including TypeScript). The gate auto-escalates to include the full Next.js build when app page components or prerendered data files are in the diff. You can also force it with `--full`.

### Handling failures

**New failures** (caused by your changes): Stop and fix. Re-run the failing check, then re-run ALL checks to make sure fixes didn't break something else.

**Pre-existing failures** (also present on clean main, not caused by your changes): To determine if a failure is pre-existing, check the CI status on the `main` branch via `gh run list --branch main -L 3` or compare against the latest main commit. Do NOT use `git stash` or `git checkout main` to test this — those operations cause branch confusion in multi-agent slots. If the same failure appears on main's CI, it's pre-existing — note it and move on. Do not block the push on pre-existing failures.

### Build artifacts

`pnpm build` may modify files like `src/data/stats.json` as a side effect. These build artifact changes should be included in the commit if they show up in `git status` after running checks.

## Step 2: Push to GitHub

1. Check `git status` for uncommitted changes. If there are any, ask the user what to do (commit, stash, etc.) — do NOT auto-commit without asking.
2. **NEVER push directly to main.** If on `main`, stop and warn the user: "You are on the main branch. Create a feature branch first." Do not proceed.
3. If on a feature branch:
   - If you ran `git pull --rebase` or `git rebase origin/main` in Step 0 (branch was diverged or had merge conflicts), push with `git push --force-with-lease -u origin HEAD` since the rebase rewrote history.
   - Otherwise push normally with `git push -u origin HEAD`.
   - Check if a PR already exists using crux:
     ```bash
     pnpm crux gh pr detect
     ```
   - If no PR exists (exit code 1), create one using crux. **Always use `--body-file` or the stdin heredoc pattern** for multi-line bodies — inline `--body="$(cat <<'EOF'...)"` fails with `/bin/sh` (used by pnpm):
     ```bash
     # Option A: stdin heredoc (safe with pnpm/sh):
     pnpm crux gh pr create --title="<descriptive title>" <<'PRBODY'
     ## Summary

     - <key change 1>
     - <key change 2>

     ## Test plan
     - [ ] <test step>

     Closes #N
     PRBODY

     # Option B: write body to file first, then use --body-file:
     # Use mktemp to avoid collisions between concurrent agents in different slots
     PR_BODY=$(mktemp /tmp/pr-body-XXXXXX.md)
     cat >| "$PR_BODY" <<'PRBODY'
     ## Summary
     ...
     PRBODY
     pnpm crux gh pr create --title="<descriptive title>" --body-file="$PR_BODY"
     rm -f "$PR_BODY"
     ```
     **After creating, always run `pnpm crux gh pr fix-body`** — this detects and repairs any literal `\n` in the PR body automatically.
   - If a PR exists, note its number and move on.

**IMPORTANT:** Always use `crux gh pr create` and `crux gh pr detect` instead of raw curl commands. The crux commands route through `githubApi()` which validates request bodies for shell-expansion corruption (ANSI codes, dotenv output, etc.) before sending to GitHub.

### Push appears to "succeed" but remote doesn't move

If you don't see `To github.com:...` after `git push`, the push didn't happen — the pre-push hook killed it. The gate's output is loud enough to bury the failure. Scroll up past the gate output to find the real error before retrying.

## Step 3: Verify GitHub is green

1. Wait 15 seconds for checks to register, then run `pnpm crux gh ci status --wait` to poll until all checks complete.
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

If all check runs show **success**: proceed to Step 3b (mergeability check).

## Step 3b: Verify PR is mergeable (MANDATORY)

CI green is necessary but not sufficient. The PR must also be mergeable (no conflicts with the base branch). GitHub computes mergeability asynchronously — poll until it resolves:

```bash
PR_NUM=$(gh pr view --json number --jq '.number')
for i in 1 2 3 4 5; do
  MERGEABLE=$(gh pr view "$PR_NUM" --json mergeable --jq '.mergeable')
  if [ "$MERGEABLE" != "UNKNOWN" ]; then break; fi
  sleep 10
done
echo "Mergeable: $MERGEABLE"
```

- **MERGEABLE**: Proceed to Step 4b.
- **CONFLICTING**: The base branch has diverged since the push. Rebase locally and re-push:
  ```bash
  git fetch origin main
  git rebase origin/main
  # Fix conflicts if any, then:
  git push --force-with-lease -u origin HEAD
  ```
  Then go back to **Step 3** — CI must re-run after a force-push, and mergeability must be re-verified.
- **UNKNOWN** (after 5 attempts): Wait 30 more seconds and retry once. If still UNKNOWN, note it in the final report and warn the user — do not declare success.

**Why this matters:** A PR can have all CI checks green but still show "This branch has conflicts that must be resolved" on GitHub. Without this check, the agent declares success on a PR that can't actually merge.

## Step 4b: Check for unresolved CodeRabbit comments

After CI passes, check whether CodeRabbit or other bots left unresolved review comments:

```bash
gh pr view <PR#> --json reviewThreads --jq '
  .reviewThreads.nodes[] |
  select(.isResolved == false and .isOutdated == false) |
  select(.comments.nodes[0].author.login == "coderabbitai" or
         .comments.nodes[0].author.login == "github-actions") |
  "\(.path):\(.line) — \(.comments.nodes[0].body[:200])"
'
```

### How to handle CodeRabbit comments

- **🔴 Critical / 🟠 Major / 🟡 Minor** — Address these. Verify the concern is valid, fix if so.
  Look for a "Prompt for AI Agents" section in the comment body — it contains ready-made instructions.
- **🧹 Nitpick** — Fix only if trivial and clearly correct. Skip if debatable.
- **Informational notes** — No action needed; these are just observations.

### CodeRabbit "Addressed in commit X" markers — DO NOT TRUST

CodeRabbit sometimes appends `✅ Addressed in commit <sha>` to a thread when it thinks a follow-up commit fixed the finding. Empirically these markers are **unreliable** in two ways:

1. **The referenced SHA may not exist.** Saw `✅ Addressed in commit 3d5cbbe` on PR #4538 and `✅ Addressed in commits 760b1ba to 2ce2219` on PR #4482 — `git show` returned `unknown revision` for both.
2. **Even when the SHA exists, the relevant code may not actually reflect the fix.** PR #4482 finding 3 was marked addressed but the code still had the bug pattern — the partial hardening that did land was unrelated.

**Always verify** before treating a finding as resolved:

```bash
git show <sha> --stat                  # 1. confirm the cited commit exists
grep -n "<bad-pattern>" <path>         # 2. grep the current file for the bug pattern
# If both are clean, finding is resolved. Otherwise treat as outstanding regardless of marker.
```

After addressing comments: commit, push, and go back to Step 3 to verify CI stays green.

### Human review — final step, not first blocker

Only flag for human review AFTER you have:
1. CI passing
2. PR mergeable (no conflicts — Step 3b verified)
3. All CodeRabbit major/minor comments addressed (or confirmed as false positives)
4. No unchecked PR checklist items

If at that point something still requires human attention (e.g., design decision, security exception),
note it clearly but do not block the PR from being labeled `stage:approved` for merge queue.

## Guardrails

- Maximum 3 full retry cycles. If still failing after 3 attempts, stop and report what's wrong so the user can decide how to proceed.
- Never force-push unless explicitly asked, **except** after a rebase in Step 0 or Step 3b (`git pull --rebase` or `git rebase origin/main`) where `--force-with-lease` is required and safe because the rebase rewrote local history.
- Never skip pre-commit hooks.
- Always show the user what failed and what you're fixing before making changes.

## Merge Queue

PRs with `stage:approved` are auto-enqueued into the GitHub merge queue by PR Patrol. The merge queue runs CI in isolation and merges automatically — you don't need to merge PRs manually. Just push, ensure CI is green, and label `stage:approved` when ready.

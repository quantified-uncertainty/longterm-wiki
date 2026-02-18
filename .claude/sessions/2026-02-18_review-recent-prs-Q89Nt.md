## 2026-02-18 | claude/review-recent-prs-Q89Nt | Fix CI workflow bugs found in PR review

**What was done:** Reviewed last 20 PRs and their GitHub Actions CI logs. Found and fixed two workflow bugs: (1) `auto-rebase.yml` used `git push origin -- "$branch" --force-with-lease` where `--` causes `--force-with-lease` to be treated as a refspec instead of a flag, breaking every rebase push; (2) `resolve-conflicts.yml` "Post failure comment" step used `DIAG="${{ steps.resolve.outputs.diagnostic_summary }}"` inline, causing bash to interpret markdown backticks in the diagnostic summary as command substitution (e.g. trying to exec `app/scripts/build-data.mjs`).

**Pages:** (none — infrastructure only)

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- PR #160 (Postgres server) is a long-lived open branch that keeps conflicting with `app/scripts/build-data.mjs` and `package.json`. The auto-resolver resolves conflicts via Claude API successfully, but the merged `build-data.mjs` fails validation in 34ms (immediate failure — likely AI-introduced syntax error). This will recur every 2 hours indefinitely. Manual intervention required.
- PR #228 (fact-wrap CLI) was closed without merging — auto-rebase tried to push after rebasing it and hit the `--force-with-lease` refspec bug.

**Learnings/notes:**
- In bash, `git push origin -- "$branch" --force-with-lease` passes `--force-with-lease` as a refspec (after `--`), not a flag. Fix: `git push --force-with-lease origin "$branch"`.
- GitHub Actions inline expression `${{ steps.X.outputs.Y }}` expands before shell runs, so any backticks in the value cause unintended command substitution. Fix: pass via `env:` block so the value arrives as a proper env var.
- All 20 PRs had green `build-and-test` and `validate` CI — the only failures were the `resolve-conflicts` and `auto-rebase` workflow jobs.
- PR #160 needs to either be closed or have its `build-data.mjs` conflict manually resolved before the auto-resolver can make progress on it.

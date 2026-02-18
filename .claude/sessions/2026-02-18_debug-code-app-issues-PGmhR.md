## 2026-02-18 | claude/debug-code-app-issues-PGmhR | Fix diverged-branch handling in push-and-ensure-green

**What was done:** Diagnosed the recurring "[ahead N, behind M]" branch state in Claude Code App sessions. Root cause: the auto-rebase GitHub Actions workflow rebases feature branches on the remote after each main merge (force-push to origin), but local sessions don't pull those changes. The old push-and-ensure-green Step 0 just warned about being behind without fixing it. Updated Step 0 to auto-rebase (`git pull --rebase`) when the branch is diverged or behind, and updated Step 2 to use `--force-with-lease` after a rebase. Added the pattern to common-issues.md.

**Pages:** (none — workflow documentation only)

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- None — changes are to workflow instruction files only (no code changes).

**Learnings/notes:**
- "[ahead 3, behind 23]" means the auto-rebase workflow ran on origin and force-pushed a rebased version, but the local session is stale. `git pull --rebase` resolves this cleanly.
- After `git pull --rebase`, a `--force-with-lease` push is required (history was rewritten).
- The root cause of branches being far behind was a now-fixed bug in auto-rebase.yml (commit 2bdf334): `git push origin -- "$branch" --force-with-lease` was treating `--force-with-lease` as a refspec due to the `--` separator.

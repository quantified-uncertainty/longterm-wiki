## 2026-02-17 | claude/resolve-merge-conflict-xOqgj | Resolve merge conflict in PR #179

**What was done:** Investigated why the Resolve Merge Conflicts GitHub Action didn't auto-fix the conflict in PR #179, then manually resolved the merge conflict in `crux/authoring/creator/research.ts`. The conflict was between the PR's verbose interface definitions and main's refactored type aliases — resolved by keeping `__dirname` (needed by the PR) and using main's `ResearchPhaseContext` type aliases.

**Pages:** (none — infrastructure fix only)

**Issues encountered:**
- The Resolve Merge Conflicts workflow didn't catch PR #179 because the PR was created at 01:09 UTC, after the last Auto-Rebase workflow (01:04 UTC) had already triggered the conflict resolver. The scheduled fallback runs only every 6 hours.

**Learnings/notes:**
- The conflict resolver has a blind spot: PRs created between Auto-Rebase runs won't be checked until the next push to main or the 6-hour cron. Consider adding a `pull_request` trigger or reducing the cron interval.

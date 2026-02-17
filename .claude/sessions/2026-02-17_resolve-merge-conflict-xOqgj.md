## 2026-02-17 | claude/resolve-merge-conflict-xOqgj | Harden conflict resolution pipeline

**What was done:** Investigated why the Resolve Merge Conflicts GitHub Action didn't auto-fix PR #179's conflict, then resolved the merge conflict in `crux/authoring/creator/research.ts` and hardened the entire conflict resolution pipeline against multiple failure modes.

**Pages:** (none — infrastructure fix only)

**Changes to resolve-conflicts.yml:**
- Added `pull_request: [opened, synchronize]` trigger so new/updated PRs immediately fire the workflow
- Reduced cron from every 6 hours to every 2 hours
- Added retry loop (3 attempts, 10s delay) for GitHub's lazy `mergeable` state computation (`UNKNOWN` → `CONFLICTING`)
- Improved failure comments to include per-file diagnostics and link to workflow logs

**Changes to resolve-conflicts.mjs:**
- Added delete/modify conflict handling (file deleted on one side, modified on the other)
- Added `stripCodeFences()` to handle models wrapping output in markdown fences
- Added diagnostic tracking system (`addDiagnostic()`) with per-file status/reason
- Added push retry with concurrent update detection (3 attempts, checks for branch divergence)
- Improved system prompts to handle TypeScript refactoring conflicts (the exact type that failed in PR #179)
- Added `existsSync` import for deleted file detection

**Issues encountered:**
- The Resolve Merge Conflicts workflow didn't catch PR #179 because the PR was created at 01:09 UTC, after the last Auto-Rebase workflow (01:04 UTC) had already triggered the conflict resolver. The scheduled fallback runs only every 6 hours.

**Learnings/notes:**
- GitHub lazily computes `mergeable` status — querying it too soon after PR creation returns `UNKNOWN`, not `CONFLICTING`. The retry loop handles this.
- The `pull_request` trigger will cause the workflow to fire on every PR open/sync, but the `find-conflicted-prs` job exits quickly when no PRs are conflicting, so the cost is just workflow minutes.

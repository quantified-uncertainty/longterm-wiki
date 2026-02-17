## 2026-02-17 | claude/resolve-merge-conflict-xOqgj | Harden CI/CD pipeline

**What was done:** Investigated why the Resolve Merge Conflicts Action didn't auto-fix PR #179's conflict, resolved it, then audited and hardened the entire CI/CD pipeline across 5 workflows.

**Pages:** (none — infrastructure fix only)

**PR:** #183

**Changes to resolve-conflicts.yml:**
- Added `pull_request: [opened, synchronize]` trigger for immediate detection
- Reduced cron from 6h to 2h, increased timeout from 30 to 45 min
- Added retry loop for GitHub's lazy `UNKNOWN` mergeable state
- Added post-resolution validation gate (`pnpm crux validate gate`) — resolves then validates before pushing, preventing broken resolutions from reaching CI
- Split resolve script into resolve+commit (--no-push) → validate → push stages
- Improved failure comments with per-file diagnostics + workflow log links

**Changes to resolve-conflicts.mjs:**
- Added `--no-push` flag for workflow-level validation between commit and push
- Added delete/modify conflict handling, `stripCodeFences()`, diagnostic tracking
- Added push retry with concurrent update detection
- Improved prompts for TypeScript refactoring conflicts

**Changes to ci-autofix.yml:**
- Fixed infinite loop: now checks ALL autofix commits since main (`origin/main..HEAD`), not just last 3 — prevents loops when normal commits land between fix attempts
- Removed unnecessary `id-token: write` permission

**Changes to claude-assistant.yml:**
- Removed unnecessary `id-token: write` permission

**Changes to auto-rebase.yml:**
- Push failures now emit `::error::` with captured output (was silent `::warning::`)
- Job now exits non-zero when any PR push fails (was always exit 0)

**Issues encountered:**
- The Resolve Merge Conflicts workflow didn't catch PR #179 due to timing gap (PR created 5 min after last workflow run, 6h cron hadn't fired)

**Learnings/notes:**
- GitHub lazily computes `mergeable` — querying too soon returns `UNKNOWN`. Retry loop handles this.
- The ci-autofix loop detector using `git log -3` could miss autofixes if normal commits interleave. `origin/main..HEAD` is reliable regardless of commit ordering.

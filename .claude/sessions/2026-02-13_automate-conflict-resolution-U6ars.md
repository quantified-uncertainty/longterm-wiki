## 2026-02-13 | claude/automate-conflict-resolution-U6ars | Add automated merge conflict resolution

**What was done:** Added two GitHub Actions workflows to automate merge conflict handling across parallel Claude Code PRs. (1) `auto-rebase.yml` — triggers on push to main, rebases all open PRs to keep them up-to-date (handles the common case of no real conflicts). (2) `resolve-conflicts.yml` + `.github/scripts/resolve-conflicts.mjs` — finds PRs with actual merge conflicts, sends each conflicted file to the Claude API (Sonnet) for semantic resolution, commits the merge, and posts a comment on the PR. Runs after auto-rebase via `workflow_run` trigger, on a 6-hour schedule, and on manual trigger. Also migrated session logging from a single shared file to per-session files in `.claude/sessions/` to eliminate the most common source of merge conflicts. Second pass: thorough security/robustness review fixed command injection (execSync -> execFileSync), added branch name validation, concurrency guards, `set -euo pipefail`, here-string loop, stop_reason truncation check, API retry with backoff, file count limit, correct permissions, workflow_run sequencing, and job timeouts.

**Issues encountered:**
- The session-log.md itself had a merge conflict (from a parallel session) — resolved manually, which motivated the migration to per-session files
- First draft had a critical command injection vulnerability via branch names in execSync calls
- Permissions were swapped between the two workflows (auto-rebase had write where it needed read, and vice versa)

**Learnings/notes:**
- Always use `execFileSync` (no shell) instead of `execSync` when incorporating external input into commands
- `workflow_run` trigger is the correct way to sequence dependent workflows — `sleep` is fragile
- Pipe into `while read` creates a subshell that swallows errors; use here-string (`<<< "$var"`) instead
- The two workflows complement each other: auto-rebase handles ~90% of cases, conflict resolver handles the rest
- Per-session files completely eliminate the #1 merge conflict source (every session prepending to the same file)
- Must delete the old `.claude/session-log.md` file when migrating — leaving it behind causes the very conflicts the migration was designed to prevent

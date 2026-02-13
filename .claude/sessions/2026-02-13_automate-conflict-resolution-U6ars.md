## 2026-02-13 | claude/automate-conflict-resolution-U6ars | Add automated merge conflict resolution

**What was done:** Added two GitHub Actions workflows to automate merge conflict handling across parallel Claude Code PRs. (1) `auto-rebase.yml` — triggers on push to main, rebases all open PRs to keep them up-to-date (handles the common case of no real conflicts). (2) `resolve-conflicts.yml` + `.github/scripts/resolve-conflicts.mjs` — finds PRs with actual merge conflicts, sends each conflicted file to the Claude API (Sonnet) for semantic resolution, commits the merge, and posts a comment on the PR. Runs after auto-rebase, on a 6-hour schedule, and on manual trigger. Also migrated session logging from a single shared file to per-session files in `.claude/sessions/` to eliminate the most common source of merge conflicts.

**Issues encountered:**
- The session-log.md itself had a merge conflict (from a parallel session) — resolved manually, which motivated the migration to per-session files

**Learnings/notes:**
- The two workflows complement each other: auto-rebase handles ~90% of cases (branch just behind main), conflict resolver handles the rest
- Conflict resolver uses `max-parallel: 1` to avoid push races when multiple PRs are conflicted
- Requires `ANTHROPIC_API_KEY` secret in the repository for the conflict resolver to work
- Uses Sonnet for cost efficiency — MDX/YAML conflicts are straightforward enough that Opus isn't needed
- Per-session files completely eliminate the #1 merge conflict source (every session prepending to the same file)

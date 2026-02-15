## 2026-02-15 | claude/fix-page-changes-update-4trhu | Fix page-changes not reading session files

**What was done:** Fixed /internal/page-changes not updating for recent PRs. The build script (build-data.mjs) only read from the consolidated `.claude/session-log.md`, but session logging was migrated to per-session files in `.claude/sessions/` — so new sessions were invisible. Updated `parseSessionLog` to also read individual session files, with deduplication and a kebab-case filter for page IDs.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- None

**Learnings/notes:**
- The migration to per-session files (to avoid merge conflicts) broke the data pipeline because the build script was never updated to read from the new location
- Session files use the exact same `## date | branch | title` format as the consolidated log, so the same parser works on both

## 2026-02-17 | claude/add-changelog-pr-links-9vI0W | Add PR links to change history

**What was done:** Added PR links to Change History UI and page-changes table. PR numbers are auto-populated at build time via GitHub API branch→PR lookup (`github-pr-lookup.mjs`), so session logs don't need to manually include them. Also added manual `**PR:**` field support in session logs as an override, backfilled 47 existing session logs, and added 8 new tests.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- The `build-data.mjs` script has a pre-existing environment issue where `DATA_DIR` resolves to `/home/user/data` instead of the repo's `data/` directory, preventing full gate validation in this sandbox

**Learnings/notes:**
- All session logs without `**Pages:**` fields are infrastructure-only sessions that don't appear in change history, so they don't need PR backfilling
- The PR field is optional and backward-compatible — entries without it render exactly as before

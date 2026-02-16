## 2026-02-16 | claude/review-pr-142-followup-HvNyE | Fix internal page leaks from PR #142

**What was done:** Reviewed PR #142 (internal entity type infrastructure) and fixed several gaps where internal pages leaked into public-facing outputs: sitemap.xml, search index, and update schedule. Also added explicit `internal` case to the entity transform switch statement and a new test.

**Pages:** (no page content changes)

**Issues encountered:**
- Internal pages were included in `sitemap.ts` via unfiltered `getAllPages()` call
- Search index in `search.mjs` didn't filter `entityType: internal` entities or `category: internal` pages
- `entity-transform.mjs` let "internal" fall through to the catch-all default case (meant for ai-transition-model types that need raw field preservation)
- `getUpdateSchedule()` had no category filter, so internal pages with `updateFrequency` would appear

**Learnings/notes:**
- When adding a new entity type, audit ALL consumers of `getAllPages()` and `getTypedEntities()` for filtering gaps
- The explore page was correctly filtered by PR #142, but sitemap and search were missed
- `validate-entities.test.ts` always fails without `database.json` — this is a pre-existing issue

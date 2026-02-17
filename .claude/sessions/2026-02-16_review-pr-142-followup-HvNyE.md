## 2026-02-16 | claude/review-pr-142-followup-HvNyE | Fix internal page leaks and numericId conflicts from PR #142

**What was done:** Reviewed PR #142 (internal entity type infrastructure) and fixed several gaps: internal pages leaked into sitemap/search/update-schedule, numericId conflicts (E698-E718) between internal pages and newer entities/pages, and a build-data bug where entity ID auto-assignment didn't account for page-level IDs. In a follow-up, merged main to resolve 11 merge conflicts (all numericId collisions), then fixed a second round of 9 numericId collisions between overview pages and YAML entities.

**Pages:** (no page content changes — only frontmatter numericId reassignment for internal and overview pages)

**PR:** #170

**Issues encountered:**
- Internal pages were included in `sitemap.ts` via unfiltered `getAllPages()` call
- Search index in `search.mjs` didn't filter `entityType: internal` entities or `category: internal` pages
- `entity-transform.mjs` let "internal" fall through to the catch-all default case
- `getUpdateSchedule()` had no category filter for internal pages
- NumericId conflicts: PR #142 assigned E698-E731 to internal pages, but newer YAML entities and overview pages also got IDs in that range
- Build-data `nextId` computation only checked entity IDs, not page-level frontmatter IDs — caused auto-assigned entity IDs to collide with existing page IDs
- After merging main, accepting main's numericIds (E732-E742) caused collisions with entities that main had already assigned those IDs to. Fix: remove stale numericIds and let build-data auto-assign fresh ones (E755-E774)
- Overview pages from main (labs-overview, accident-overview, etc.) also had numericId collisions with YAML entities — same fix applied

**Learnings/notes:**
- When adding a new entity type, audit ALL consumers of `getAllPages()` and `getTypedEntities()` for filtering gaps
- The `build-data.mjs` ID assignment has two phases (entities then pages) — `nextId` must consider BOTH before auto-assigning
- When resolving numericId merge conflicts, don't accept either side — remove the numericId entirely and let build-data assign a fresh one to avoid collisions

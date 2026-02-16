## 2026-02-16 | claude/review-pr-142-followup-HvNyE | Fix internal page leaks and numericId conflicts from PR #142

**What was done:** Reviewed PR #142 (internal entity type infrastructure) and fixed several gaps: internal pages leaked into sitemap/search/update-schedule, numericId conflicts (E698-E718) between internal pages and newer entities/pages, and a build-data bug where entity ID auto-assignment didn't account for page-level IDs.

**Pages:** (no page content changes — only frontmatter numericId reassignment for 34 internal pages)

**Issues encountered:**
- Internal pages were included in `sitemap.ts` via unfiltered `getAllPages()` call
- Search index in `search.mjs` didn't filter `entityType: internal` entities or `category: internal` pages
- `entity-transform.mjs` let "internal" fall through to the catch-all default case
- `getUpdateSchedule()` had no category filter for internal pages
- NumericId conflicts: PR #142 assigned E698-E731 to internal pages, but newer YAML entities and overview pages also got IDs in that range
- Build-data `nextId` computation only checked entity IDs, not page-level frontmatter IDs — caused auto-assigned entity IDs to collide with existing page IDs

**Learnings/notes:**
- When adding a new entity type, audit ALL consumers of `getAllPages()` and `getTypedEntities()` for filtering gaps
- The `build-data.mjs` ID assignment has two phases (entities then pages) — `nextId` must consider BOTH before auto-assigning
- Internal pages now have E720-E753 (safely above the E718 max used by overview pages)

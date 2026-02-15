## 2026-02-15 | claude/fix-page-names-xrFxa | Fix Related Pages showing numeric IDs instead of titles

**What was done:** Fixed a bug where Related Pages cards displayed raw numeric IDs (e.g., "E22", "E521") instead of actual page titles. The root cause was that `scanContentEntityLinks` in `build-data.mjs` extracted EntityLink IDs from MDX content as-is, but when those IDs were numeric (e.g., `<EntityLink id="E22">`), they couldn't be resolved against the entity map which is keyed by slugs. The fix resolves numeric IDs to slugs via the `numericIdToSlug` registry before they enter the related-pages graph, and pre-populates the registry with page-level numericIds so page-only entries are also resolved.

**Pages:** (none — infrastructure fix only)

**Issues encountered:**
- Two-phase ID registry population: entity-level numericIds were populated first, but page-only entries (like `factors-*-overview`) had their numericIds added in a later phase, after `scanContentEntityLinks` had already run. Required pre-populating page numericIds before the scan.
- One dangling reference (E616 in `knowledge-monopoly.mdx`) refers to a non-existent entity — pre-existing data issue, not related to this fix.

**Learnings/notes:**
- The `numericIdToSlug` map is built incrementally across two phases in `build-data.mjs`. Any code that needs the full mapping must run after both phases, or pre-populate from pages as we did here.

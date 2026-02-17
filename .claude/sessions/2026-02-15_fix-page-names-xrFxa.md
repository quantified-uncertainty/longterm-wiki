## 2026-02-15 | claude/fix-page-names-xrFxa | Fix Related Pages showing numeric IDs instead of titles

**What was done:** Fixed a bug where Related Pages cards displayed raw numeric IDs (e.g., "E22", "E521") instead of actual page titles. Two changes: (1) `scanContentEntityLinks` in `build-data.mjs` now resolves numeric IDs to slugs before they enter the related-pages graph, with page-level numericIds pre-populated. (2) Updated the `entitylink-ids` validation rule to warn when authors use numeric IDs in EntityLink components and provide an auto-fix to replace them with slug IDs. Auto-fixed all 5896 existing numeric ID usages across 523 MDX files.

**Pages:** (none — infrastructure fix only; MDX files were auto-fixed but no page content changed)

**PR:** #139

**Issues encountered:**
- Two-phase ID registry population: page-only entries had numericIds added in a later phase. Required pre-populating page numericIds before the EntityLink scan.
- One dangling reference (E616 in `knowledge-monopoly.mdx`) refers to a non-existent entity — pre-existing data issue.

**Learnings/notes:**
- The `numericIdToSlug` map is built incrementally across two phases in `build-data.mjs`. Any code that needs the full mapping must run after both phases, or pre-populate from pages as we did here.
- The `entitylink-ids` validation rule now prevents this issue from recurring by warning on numeric ID usage with `pnpm crux validate unified --rules=entitylink-ids`.

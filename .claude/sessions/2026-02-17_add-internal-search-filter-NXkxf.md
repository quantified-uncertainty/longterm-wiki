## 2026-02-17 | claude/add-internal-search-filter-NXkxf | Add Internal filter to Explore page

**What was done:** Added an "Internal" entity filter to the Explore page so internal pages (style guides, architecture docs, reports, etc.) are discoverable via search and filtering. Previously internal pages were completely excluded from the Explore grid and search index.

**Pages:** (no page content changes — infrastructure only)

**PR:** #177

**Issues encountered:**
- None

**Learnings/notes:**
- Internal pages were excluded in three places: `getExploreItems()` in `data/index.ts`, the search index builder in `search.mjs`, and validated by a test in `data.test.ts`. All three needed updating.

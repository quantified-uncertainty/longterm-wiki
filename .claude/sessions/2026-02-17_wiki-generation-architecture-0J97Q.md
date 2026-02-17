## 2026-02-17 | claude/wiki-generation-architecture-0J97Q | Route internal pages through /wiki/E<id>

**What was done:** Migrated internal pages from `/internal/` to `/wiki/E<id>` URLs so they render with full wiki infrastructure (breadcrumbs, metadata, quality indicators, sidebar). Internal MDX pages now redirect from `/internal/slug` to `/wiki/E<id>`, while React dashboard pages (suggested-pages, updates, page-changes, etc.) remain at `/internal/`.

**Pages:** wiki-generation-architecture, stub-style-guide

**Issues encountered:**
- `resolveContentPath()` only tried `.mdx` extension, causing 404s for `.md` internal pages (e.g., stub-style-guide.md) — fixed by adding `.md` fallback
- Index files (index.md/mdx) were excluded from pages list in build-data.mjs, preventing numericId registration — fixed by including them with `__index__/` slug pattern
- Test `validate-entities.test.ts` failed because index pages don't have entity definitions — added exclusion for `__index__/` pages

**Learnings/notes:**
- 8 React dashboard pages under `/internal/` (suggested-pages, updates, page-changes, facts, importance-rankings, similarity, interventions, proposals) have no entity IDs and remain at `/internal/` routes
- Batch-updated 92 `/internal/` links across 20 MDX files to `/wiki/E<id>` canonical URLs; 6 remaining links correctly reference React dashboard pages
- The `InternalSidebar` component is now unused (replaced by `WikiSidebar` + `getInternalNav()`) but left in place

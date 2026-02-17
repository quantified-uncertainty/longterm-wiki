## 2026-02-17 | claude/wiki-generation-architecture-0J97Q | Route internal pages through /wiki/E<id>

**What was done:** Migrated internal pages from `/internal/` to `/wiki/E<id>` URLs so they render with full wiki infrastructure (breadcrumbs, metadata, quality indicators, sidebar). Internal MDX pages now redirect from `/internal/slug` to `/wiki/E<id>`, while React dashboard pages (suggested-pages, updates, page-changes, etc.) remain at `/internal/`. Follow-up review: cleaned up dead code, hid wiki-specific UI on internal pages, fixed breadcrumbs, updated all bare-text `/internal/` references.

**Pages:** wiki-generation-architecture, stub-style-guide, page-types, risk-style-guide, response-style-guide, ai-transition-model-style-guide, documentation-maintenance, project-roadmap

**Issues encountered:**
- `resolveContentPath()` only tried `.mdx` extension, causing 404s for `.md` internal pages (e.g., stub-style-guide.md) — fixed by adding `.md` fallback
- Index files (index.md/mdx) were excluded from pages list in build-data.mjs, preventing numericId registration — fixed by including them with `__index__/` slug pattern
- Test `validate-entities.test.ts` failed because index pages don't have entity definitions — added exclusion for `__index__/` pages

**Learnings/notes:**
- 8 React dashboard pages under `/internal/` (suggested-pages, updates, page-changes, facts, importance-rankings, similarity, interventions, proposals) have no entity IDs and remain at `/internal/` routes
- Batch-updated 92 `/internal/` links across 20 MDX files to `/wiki/E<id>` canonical URLs; remaining links correctly reference React dashboard pages or filesystem paths
- Deleted dead code: `InternalSidebar.tsx` component, `INTERNAL_NAV` constant from `internal-nav.ts`
- Internal pages now hide: LlmWarningBanner, PageStatus, DataInfoBox, RelatedPages, PageFeedback, InfoBoxToggle, JsonLd, Data link; breadcrumbs show "Internal" instead of "Wiki"
- Internal pages have `robots: { index: false, follow: false }` metadata

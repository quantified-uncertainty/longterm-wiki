## 2026-02-17 | claude/formalize-wiki-sections-2aqHv | Formalize wiki section sidebars and /wiki page filter

**What was done:** Extended sidebar navigation to all knowledge-base sections with fully data-driven navigation. Section titles come from index page frontmatter, subcategory groupings are derived from page.subcategory fields, and labels are formatted from slugs. No hardcoded section configs. Also added a "Section" filter row to the /wiki explore page. After PR review: removed DRY violations (redundant getModelsNav/getMetricsNav/getReferenceNav), made "Other" section filter a dynamic catch-all, added edge case guards.

**Pages:** (no page content changes — infrastructure/UI only)

**Issues encountered:**
- Initial implementation had hardcoded KB_SECTIONS config — refactored to be fully programmatic
- PR review found getModelsNav() was 100% identical to getKbSectionNav("models") — removed redundancy
- ExploreGrid "Other" section only matched 4 hardcoded categories, missing ATM and other pages — made dynamic

**Learnings/notes:**
- Navigation is now fully data-driven via a generic `buildSectionNav()` function that reads page.category, page.subcategory, and index page titles
- Section titles come from `getPageById("__index__/knowledge-base/{section}")?.title`
- Subcategory labels are derived from slugs via `formatLabel()` (kebab-case → Title Case)
- `getKbSectionNav()` is the single entry point for all KB section navs (models, metrics, risks, etc.), with a `defaultOpen` parameter
- To customize a subcategory label, update the subcategory value in page frontmatter — the nav derives from data, not code
- ATM sidebar still uses hardcoded grouping because its subcategories are hierarchical and non-trivially grouped
- ExploreGrid "Other" is now a dynamic catch-all: any category not explicitly claimed by a named group appears there

## 2026-02-17 | claude/formalize-wiki-sections-2aqHv | Formalize wiki section sidebars and /wiki page filter

**What was done:** Extended sidebar navigation to all knowledge-base sections (risks, responses, organizations, people, capabilities, etc.) with subcategory grouping for large sections. Added a "Section" filter row to the /wiki explore page so users can filter by wiki section.

**Pages:** (no page content changes — infrastructure/UI only)

**Issues encountered:**
- None

**Learnings/notes:**
- KB sections are configured via `KB_SECTIONS` in `wiki-nav.ts` with optional `subcategoryGroups` for sections that have subcategories (risks, responses, organizations)
- Sections without subcategories (people, capabilities, debates, etc.) get a flat alphabetical list in the sidebar
- Models and metrics retain their existing specialized sidebar builders
- The `detectSidebarType` function now returns `"kb"` for all knowledge-base sections not handled by the models/metrics sidebar, and `getWikiNav` extracts the section key from the entityPath

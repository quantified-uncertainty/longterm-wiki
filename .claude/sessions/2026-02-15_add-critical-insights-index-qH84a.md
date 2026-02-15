## 2026-02-15 | claude/add-critical-insights-index-qH84a | Add Critical Insights index page

**What was done:** Created a new internal page at `/internal/insights` with a sortable table of all 1041 insights. Also wired the previously-stubbed `<InsightsTable />` MDX component to a real implementation, so the public insights page at `/insight-hunting/insights` now renders the full table. Extracted shared `getPageTitleMap()` helper and `InsightsTableClient` component to avoid duplication.

**Pages:** (no wiki page content edited — infrastructure/components only)

**Issues encountered:**
- The `<InsightsTable />` MDX component was a stub (empty gray box) on the public insights page — fixed by creating a server component wrapper + shared client table component.

**Learnings/notes:**
- Insights are stored in 6 YAML files under `data/insights/` by type (claim, counterintuitive, quantitative, research-gap, disagreement, neglected)
- MDX components can be server components (no "use client") and import from `@/data` — they render server-side during MDX compilation
- The pageTitleMap builder was duplicated in `getInsights()` and `getExploreItems()` — extracted to shared `getPageTitleMap()` function

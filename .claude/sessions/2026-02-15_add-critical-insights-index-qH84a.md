## 2026-02-15 | claude/add-critical-insights-index-qH84a | Add Critical Insights index page

**What was done:** Created a new internal page at `/internal/insights` with a sortable table of all insights. The table displays all insight dimensions (surprising, important, actionable, neglected, compact, composite) as sortable columns, plus type badges, source links, and tags. Added `getInsights()` data layer function and sidebar nav entry.

**Pages:** (no wiki pages edited — internal infrastructure only)

**Issues encountered:**
- None

**Learnings/notes:**
- Insights are stored in 6 YAML files under `data/insights/` by type (claim, counterintuitive, quantitative, research-gap, disagreement, neglected)
- The `InsightsTable` component in mdx-components.tsx was previously a stub — this new page uses a dedicated route instead
- Pattern for internal data pages: server page loads from `@/data`, passes props to `"use client"` table component using DataTable from `@/components/ui/data-table`

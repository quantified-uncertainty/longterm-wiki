## 2026-02-16 | claude/explore-wiki-dashboard-d1uuh | Add interventions & proposals dashboards

**What was done:** Created rich internal dashboards at `/internal/interventions` and `/internal/proposals` to surface structured data from `data/interventions.yaml` (14 entries) and `data/proposals.yaml` (27 entries) that were previously dead data in the build pipeline. Features: expandable rows showing full InterventionCard/ProposalCard, summary stat cards, category/domain filter tabs, cost-effectiveness leverage column with dollar-range parsing (EV/cost ratio), and custom sorting. Added `Intervention` and `Proposal` types plus getter functions to the data layer.

**Pages:** (no wiki content pages changed)

**Issues encountered:**
- `computeLeverage` was initially in a `"use client"` file but called from a server component — had to extract parsing utils into a separate non-client module (`leverage.ts`)

**Learnings/notes:**
- `interventions` and `proposals` keys were already being loaded into `database.json` by `build-data.mjs` but the `DatabaseShape` interface and data layer had no corresponding fields or getters — pure dead data until now
- The DataTable `renderExpandedRow` prop works with the "new API" (passing a table instance) but requires `getExpandedRowModel()` in the useReactTable options
- Dollar range parsing handles varied formats: "$300K-1M", "$1-5M" (suffix inheritance), "$0-50K", "$500M-2B", stripping "/year" and other descriptors

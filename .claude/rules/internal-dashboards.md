# Internal Dashboards for New Features

**When building significant new features, always consider creating an internal dashboard page** (`/internal/<feature>`) to visualize the feature's data, status, and history. Dashboards are essential for debugging, monitoring, and iterating on features later.

## When to build a dashboard

Any feature that:
- Produces data over time (run history, discovered items, status tracking, metrics)
- Involves a pipeline with multiple stages (where seeing intermediate results aids debugging)

## How to build one

1. Create `apps/web/src/app/internal/<name>/page.tsx` (server component — loads data)
2. Create `apps/web/src/app/internal/<name>/<name>-table.tsx` (client component — `"use client"` with `DataTable` from `@/components/ui/data-table.tsx`)
3. Add navigation entry in `apps/web/src/lib/wiki-nav.ts` under "Dashboards & Tools"
4. Server components can read YAML/JSON files directly via `fs` for operational data
5. Follow existing patterns in `apps/web/src/app/internal/updates/` or `auto-update-runs/`

## Existing dashboards

Update Schedule, Page Changes, Fact Dashboard, Auto-Update Runs, Auto-Update News, Importance Rankings, Page Similarity, Interventions, Proposals.

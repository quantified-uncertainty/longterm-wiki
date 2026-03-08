# Internal Dashboards for New Features

**When building significant new features, always consider creating an internal dashboard page** to visualize the feature's data, status, and history. Dashboards are essential for debugging, monitoring, and iterating on features later.

## When to build a dashboard

Any feature that:
- Produces data over time (run history, discovered items, status tracking, metrics)
- Involves a pipeline with multiple stages (where seeing intermediate results aids debugging)

## How to build one (Pattern A — MANDATORY)

All dashboards **must** use the MDX wiki page pattern (Pattern A). Do not create raw `/internal/<name>` App Router pages without entity IDs.

1. **Allocate an entity ID**: `pnpm crux ids allocate <slug>-dashboard`
2. **Create content component**: `apps/web/src/app/internal/<name>/<name>-content.tsx`
   - Export a named function (e.g., `MyFeatureContent`)
   - No `<article>` wrapper, no `<h1>`, no `metadata` export — the wiki page shell handles those
   - Keep data loading, stats, tables, `DataSourceBanner`
3. **Create MDX stub**: `content/docs/internal/<slug>-dashboard.mdx`
   ```yaml
   ---
   numericId: E<id>
   title: "<Title>"
   description: "<Description>"
   subcategory: dashboards          # or citations
   contentFormat: dashboard
   lastEdited: "<date>"
   ---
   <MyFeatureContent />
   ```
4. **Register component** in `apps/web/src/components/mdx-components.tsx`
5. **Create redirect page**: Convert `page.tsx` to `redirect("/wiki/E<id>")`
6. **Create table component** (if needed): `<name>-table.tsx` — client component with `"use client"` and `DataTable`
7. **Add sidebar entry** in `apps/web/src/lib/wiki-nav.ts` using `internalHref("<slug>-dashboard")`

Follow existing patterns in `apps/web/src/app/internal/page-coverage/` (Pattern A reference implementation).

## Existing dashboards

All dashboards have entity IDs and use Pattern A (MDX stub + content component + redirect).

**Dashboards:** Pages (E899), Entities (E908), Page Changes (E909), Update Schedule (E900), Suggested Pages (E910), Improve Runs (E911), Agent Sessions (E912), Session Insights (E913), Auto-Update Runs (E914), Auto-Update News (E915), Active Agents (E925), Groundskeeper Runs (E926), System Health (E927).

**Citations:** Fact Dashboard (E898), Resources, Citation Accuracy (E917), Citation Content (E918), Hallucination Risk (E919), Hallucination Evals (E920).

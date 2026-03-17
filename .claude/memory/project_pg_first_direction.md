---
name: PG-first data layer direction
description: Entity source data moving to Postgres; database.json being phased out. Epic #2428 with 12 issues filed.
type: project
---

Entity source data is moving to PG-first. The long-term direction is to phase out `database.json` as the primary entity data source. Tracked in **Epic #2428** with 12 issues (#2429-#2440).

**Why:** The current build-time pipeline (YAML → build-data.mjs → database.json → Next.js) means entity data updates require a full rebuild. PG-first (proven with orgs/people directories) enables real-time data without rebuilds.

**How to apply:**
- New directory pages and entity listings should query wiki-server PG, not database.json
- The `entities` table (not Things) is the target, with a new `typed_data JSONB` column for type-specific fields (#2431)
- Page ratings/importance become temporal rows in `wikibase_page_assessments` — not frontmatter fields (#2429)
- WikiBase-derived metrics (coverage, rankings, similarity) written to PG by build pipeline (#2434)
- database.json shrinks to a WikiBase rendering cache (~2-3 MB) for synchronous MDX component access (#2435)
- Build pipeline becomes a *writer* to PG (compute metrics, sync entities) rather than the sole data source
- Cruxes merge into entity system (#2430), experts merge into personnel + typed_data (#2433)
- Codebase restructured with physical `packages/tablebase/`, `packages/wikibase/` directories and PG table prefixes (#2436)
- YAML stays as source of truth during migration; only retired after PG has audit logging and admin UI
- MDX components always need a local build cache (synchronous access constraint) — database.json can't fully go away, just slim down

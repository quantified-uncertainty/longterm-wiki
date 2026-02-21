# PostgreSQL Migration Review — Current State & Opportunities

**Date:** 2026-02-21
**Reviewed PRs:** #426–#480 (25 merged PRs, 18 Postgres-related)
**Branch:** `claude/review-postgres-changes-UiUBx`

---

## Executive Summary

Over the last ~20 PRs, the wiki-server has been rapidly built out from a minimal Hono+Postgres service (entity IDs only) into a substantial data platform with **13 Drizzle migration files**, **15 tables**, **11 API route modules**, and a rich HTTP client library. The migration follows a disciplined dual-write pattern: YAML stays authoritative while Postgres serves as an indexed read mirror with fire-and-forget sync.

This review identifies **10 areas where further migration or cleanup would improve the system**, ranked by impact.

---

## Current State of the Postgres Migration

### Tables in Postgres (15 total)

| Table | PR | Primary Use | Sync Method | Source of Truth |
|---|---|---|---|---|
| `entity_ids` | #426 | Numeric ID allocation | Direct write | **Postgres** (authoritative) |
| `wiki_pages` | #428 | Page metadata + FTS | CI sync job | YAML/MDX → Postgres |
| `citation_quotes` | #426 | Citation quote extraction | Fire-and-forget | **Postgres** |
| `citation_content` | #426 | Fetched URL content cache | Fire-and-forget | **Postgres** |
| `citation_accuracy_snapshots` | #440 | Per-page accuracy trends | Computed snapshot | **Postgres** |
| `edit_logs` | #436 | Edit history entries | Dual-write (YAML primary) | YAML + Postgres |
| `hallucination_risk_snapshots` | #444 | Risk score history | Build-time write | **Postgres** |
| `sessions` | #441 | Session log entries | Fire-and-forget | YAML + Postgres |
| `session_pages` | #441 | Session ↔ page join | Fire-and-forget | YAML + Postgres |
| `auto_update_runs` | #442 | Auto-update run history | Best-effort | YAML + Postgres |
| `auto_update_results` | #442 | Per-page update results | Best-effort | YAML + Postgres |
| `resources` | #443 | External resource metadata | CI sync job | YAML → Postgres |
| `resource_citations` | #443 | Resource ↔ page citations | CI sync job | YAML → Postgres |
| `summaries` | #479 | LLM-generated summaries | Direct write | **Postgres** |
| `claims` | #479 | Structured entity claims | Direct write | **Postgres** |

### API Surface (11 route modules)

- `/api/ids` — Numeric ID allocation (authoritative)
- `/api/pages` — Search, sync, get, list
- `/api/citations` — Quote CRUD, accuracy verdicts, content cache, dashboard, trends
- `/api/edit-logs` — Append, list, stats
- `/api/hallucination-risk` — Batch record, history, stats, latest
- `/api/sessions` — Create, list, by-page, stats, page-changes
- `/api/auto-update-runs` — Record, list, stats
- `/api/resources` — Upsert, search, stats, by-page, lookup
- `/api/summaries` — Upsert, list, stats
- `/api/claims` — Insert, list, by-entity, stats, clear
- `/health` — Health check (unauthenticated)

### What's Still File-Only (Not in Postgres)

| Data | Files | Est. Size | Notes |
|---|---|---|---|
| **Entities** (core definitions) | `data/entities/*.yaml` (24 files) | ~37K lines | The big one — types, descriptions, relatedEntries, sources, customFields |
| **Facts** (canonical numbers) | `data/facts/*.yaml` (5 files) | ~2K lines | Valuations, funding, team sizes, etc. |
| **Fact measures** | `data/fact-measures.yaml` | 7KB | Unit/display definitions |
| **Experts** | `data/experts.yaml` | 10KB | Expert profiles |
| **Organizations** (metadata) | `data/organizations.yaml` | 8KB | Separate from entity YAML |
| **Interventions** | `data/interventions.yaml` | 15KB | Safety interventions |
| **Proposals** | `data/proposals.yaml` | 24KB | Research proposals |
| **Cruxes** | `data/cruxes.yaml` | 77KB | Crux entities with arguments |
| **Glossary** | `data/glossary.yaml` | 7KB | Term definitions |
| **Literature** | `data/literature.yaml` | 24KB | Publication sources |
| **Publications** | `data/publications.yaml` | 15KB | Publication metadata |
| **Funders** | `data/funders.yaml` | 15KB | Funder organizations |
| **Estimates** | `data/estimates.yaml` | 21KB | Estimate sources |
| **Parameter graph** | `data/parameter-graph.yaml` | 109KB | Squiggle dependency graph |
| **External links** | `data/external-links.yaml` | Small | Page → external URL map |
| **Auto-update config** | `data/auto-update/sources.yaml` etc. | Small | RSS sources, watchlist |
| **Search index** | `public/search-index.json` + `search-docs.json` | ~1MB | MiniSearch client-side index |

---

## Opportunity 1: Eliminate Dual-Read Fallback Pattern in Dashboards (HIGH)

**Problem:** Four internal dashboards (auto-update-runs, citation-accuracy, hallucination-risk, page-changes) each independently implement a "try API, fallback to YAML" pattern with no shared abstraction. Each dashboard has ~30-50 lines of bespoke fallback logic.

**Current state:**
```typescript
// Repeated in 4 dashboards:
async function loadFromApi() {
  const url = process.env.LONGTERMWIKI_SERVER_URL;
  if (!url) return null;
  try { /* fetch + parse */ } catch { return null; }
}
const data = (await loadFromApi()) ?? loadFromLocalFiles();
```

**Recommendation:**
1. Create a shared `fetchFromServerOrFallback<T>(path, fallbackFn)` utility in `apps/web/src/lib/wiki-server.ts`
2. Move the `LONGTERMWIKI_SERVER_URL` / API key handling into one place
3. Each dashboard reduces to a single call with a typed fallback

**Why now:** The wiki-server is deployed and stable. The fallback pattern should be a thin wrapper, not 4 copies of the same code. When bugs are found (e.g., timeout tuning, error handling), they need to be fixed in one place.

---

## Opportunity 2: Migrate Client-Side Search to Postgres Full-Text Search (HIGH)

**Problem:** The app ships a ~1MB client-side MiniSearch index (`search-index.json` + `search-docs.json`). This is loaded lazily via `fetch()` on the client. Meanwhile, Postgres already has a `wiki_pages` table with `tsvector`/GIN-indexed full-text search that the Discord bot uses via `/api/pages/search`.

**Current architecture:**
- **Client (browser):** MiniSearch (client-side, ~1MB download, fuzzy prefix search)
- **Discord bot:** Postgres FTS via wiki-server `/api/pages/search`
- **Internal dashboards:** Neither (just browse/filter database.json)

**Recommendation:**
1. Add a `/api/pages/search` proxy route in the Next.js app (server-side) or use it from a client component via an API route
2. Replace or supplement MiniSearch with server-side Postgres FTS for the main `SearchDialog`
3. Keep MiniSearch as an optional instant-response fallback for offline/degraded mode
4. Remove the ~1MB search index files from the public bundle

**Benefits:** Smaller bundle, search over full page content (not just metadata), consistent search results between app and Discord bot, real-time updates (no rebuild needed for new pages to be searchable).

**Trade-off:** Adds a network round-trip to search. Could be mitigated with debouncing and the MiniSearch-as-fallback approach.

---

## Opportunity 3: Migrate Canonical Facts to Postgres (MEDIUM-HIGH)

**Problem:** Canonical facts (`data/facts/*.yaml`) are the most dynamic, high-value data in the wiki — valuations, funding rounds, team sizes, revenue figures. They change frequently and drive `<F>`, `<Calc>`, and `<FactTimeseries>` components. Currently they:
- Live only in YAML (5 files, ~2K lines)
- Are compiled into `database.json` at build time
- Have no history/audit trail in the DB (only YAML git history)
- Have a timeseries model (`factTimeseries`) built at compile time that would benefit from SQL queries

**Recommendation:**
1. Add a `facts` table: `(entity_id, fact_id, value, numeric, low, high, as_of, label, source, source_resource, measure, note, created_at, updated_at)`
2. Add a `fact_measures` table for measure definitions
3. Dual-write from YAML to Postgres (like edit-logs pattern)
4. Build a `/api/facts` endpoint with timeseries queries — this enables the fact dashboard and `<FactTimeseries>` component to query directly
5. Eventually: fact CRUD via API, with YAML export for version control

**Why:** Facts are the canonical "source of truth" data. Having them in Postgres enables: temporal queries ("what was Anthropic's valuation in 2024?"), aggregation ("total AI safety funding across all orgs"), cross-entity comparison, and API-driven updates from auto-update pipelines.

---

## Opportunity 4: Add an Entities Table (MEDIUM-HIGH)

**Problem:** Entity definitions are the core data model — ~625 entities across 24 YAML files. They're compiled into `database.json.typedEntities` at build time. The `wiki_pages` table has some entity metadata (type, category, quality) but not the full entity definition (relatedEntries, sources, customFields, descriptions).

**Current gap:** When a dashboard or API consumer wants entity data, they must either:
- Read from `database.json` (only available at build time or in the Next.js server)
- Parse YAML files directly (slow, no indexing)

**Recommendation:**
1. Add an `entities` table mirroring the Zod schema in `entity-schemas.ts`: `(id, type, title, description, category, subcategory, tags JSONB, related_entries JSONB, sources JSONB, custom_fields JSONB, quality, reader_importance)`
2. Sync from YAML in the same CI job as pages (`sync-content`)
3. Add query endpoints: by type, by tag, related entities, cross-references

**Why:** Entities are the backbone. Having them in Postgres enables: graph queries (related entities), type-filtered browsing via API, entity-to-entity similarity search, and powers the Discord bot and any future external API.

---

## Opportunity 5: Consolidate Edit Log Source of Truth (MEDIUM)

**Problem:** Edit logs are dual-written to both YAML (`data/edit-logs/<page>.yaml`, ~625 files) and Postgres. YAML is currently authoritative, Postgres is fire-and-forget. The YAML files:
- Add ~625 files to the git repo (one per page)
- Must be read at build time to populate `database.json.pages[].changeHistory`
- Are never read at runtime by the Next.js app (only database.json)

**Recommendation:**
1. Make Postgres the authoritative source for edit logs
2. Remove YAML write from `appendEditLog()` in `crux/lib/edit-log.ts`
3. Have `build-data.mjs` fetch edit logs from the wiki-server API instead of reading ~625 YAML files
4. Delete `data/edit-logs/` directory (~625 files, reducing repo clutter)
5. Keep the seed script for disaster recovery

**Why:** Edit logs are append-only operational data, not content. They don't benefit from YAML/git version control (each file is an append-only log). The Postgres table already has all the data via dual-write. This removes ~625 files from the repo and simplifies the build pipeline.

**Risk:** Requires wiki-server to be available during build. Mitigate with: cached fallback (keep last-known edit logs in build artifacts), or accept that the build already depends on the server for risk snapshots.

---

## Opportunity 6: Consolidate Session Log Source of Truth (MEDIUM)

**Problem:** Same pattern as edit logs. Session logs are in `.claude/sessions/*.yaml` AND in Postgres `sessions` + `session_pages` tables. The page-changes dashboard already prefers the API. But `build-data.mjs` still parses session log YAML files to populate `changeHistory`.

**Recommendation:**
1. Have `build-data.mjs` fetch sessions from `/api/sessions/page-changes` instead of parsing YAML
2. Keep YAML files as the authoring format (they're written by the agent-session-ready-PR skill)
3. Ensure `sync-session.ts` is called reliably (not just fire-and-forget) — make it part of the session-end workflow

**Why:** Reduces build complexity. The session YAML files should still exist (they're human-readable audit trail), but the build shouldn't need to parse them.

---

## Opportunity 7: Auto-Update News to Postgres (MEDIUM)

**Problem:** The auto-update news dashboard (`/internal/auto-update-news/`) is the only dashboard that reads YAML files at runtime with NO Postgres fallback. It reads `data/auto-update/runs/*-details.yaml`, `sources.yaml`, and `state.yaml` directly.

**Recommendation:**
1. Add an `auto_update_news_items` table (or extend `auto_update_results` with news item data)
2. Store the digest items (title, URL, relevance score, matched pages) alongside run results
3. Update the dashboard to use the API-first pattern like other dashboards

**Why:** Consistency — this is the last holdout from the "all dashboards use API with YAML fallback" pattern. Also makes news data queryable (e.g., "what news items were routed to page X?").

---

## Opportunity 8: Clean Up the wiki-server-client.ts API (MEDIUM-LOW)

**Problem:** The `crux/lib/wiki-server-client.ts` module has grown to 750 lines with 22+ exported functions. All error handling silently returns `null`, making it hard to distinguish "server unavailable" from "bad request" from "timeout".

**Recommendations:**
1. **Add error discrimination:** Return `{ data: T } | { error: 'unavailable' | 'timeout' | 'bad_request', message: string }` instead of `T | null`
2. **Extract typed API modules:** Split into `wiki-server/edit-logs.ts`, `wiki-server/citations.ts`, etc., with a shared `wiki-server/client.ts` base
3. **Add request logging:** Optional debug logging for troubleshooting sync failures
4. **Unify timeout handling:** The `apiRequest` helper uses 5s timeout, but `recordRiskSnapshots` manually implements 30s batched timeout. Standardize on a configurable timeout.

**Why:** As more code depends on the wiki-server, silent null returns become harder to debug. A "the server rejected your request because field X is missing" error is much more actionable than "sync silently failed."

---

## Opportunity 9: Shared API Types Between Server and Client (LOW-MEDIUM)

**Problem:** The wiki-server route handlers define Zod schemas for request/response validation. The `wiki-server-client.ts` defines TypeScript interfaces for the same shapes. These are manually kept in sync with no shared types.

**Recommendation:**
1. Create a `packages/wiki-api-types/` or `apps/wiki-server/src/types.ts` with shared request/response schemas
2. Export Zod schemas from the server, import them in the client
3. Use `z.infer<typeof Schema>` for type safety across the boundary

**Why:** Prevents drift between server validation and client types. Currently a schema change in a route handler requires a matching manual change in `wiki-server-client.ts`.

---

## Opportunity 10: Replace database.json with Direct Postgres Reads (LONG-TERM)

**Problem:** The 11MB `database.json` file is the central data artifact. It's generated by a 1,500-line build script from 24+ YAML files, 5 fact files, 10 resource files, ~625 edit log files, and GitHub API data. It takes meaningful time to build and any data change requires a full rebuild.

**Current flow:**
```
YAML files → build-data.mjs → database.json (11MB) → Next.js reads at server startup
```

**Long-term vision:**
```
YAML files → sync to Postgres (CI) → Next.js reads from Postgres via wiki-server API
```

**This is NOT recommended as a near-term project.** It would require:
- Migrating all entity types, facts, measures, publications, experts, interventions, proposals, cruxes, glossary, estimates, parameter graphs, and backlinks to Postgres
- Rewriting the data layer (`apps/web/src/data/index.ts`) to fetch from API instead of JSON
- Ensuring the wiki-server is always available for Next.js builds
- Handling the parameter graph and related-entity computations server-side

**When to consider:** Once entities (#4), facts (#3), and the remaining YAML data types are in Postgres, the case for eliminating `database.json` becomes compelling. The build script would shrink from 1,500 lines to a simple sync verification.

---

## Code Quality Observations from the PR Review

### Positive Patterns
- **Consistent Drizzle usage:** All 13 migrations are idempotent. Schema definitions are clean and well-indexed.
- **Disciplined dual-write:** YAML stays authoritative during transition. No data loss risk.
- **Good test coverage:** Each new route module comes with unit tests. Wiki-server has 138 tests.
- **Batch operations everywhere:** All routes support both single and batch operations, preventing N+1 issues.
- **Fire-and-forget resilience:** Sync failures don't block content operations.

### Issues to Address
1. **N+1 in `sessions/` route (fixed in #474):** The `GET /` endpoint was fetching page associations per-session. Fixed with batch lookup, but worth auditing other routes for similar patterns.
2. **`claims/batch` has sequential inserts inside transaction:** The batch endpoint loops with individual inserts instead of using a single `INSERT ... VALUES` with multiple rows. Same pattern in `summaries/batch`. Should use Drizzle's `values([...])` for true batch insert.
3. **No pagination in `accuracy-dashboard` endpoint:** The `GET /accuracy-dashboard` loads ALL quotes into memory for server-side aggregation. With growing data, this will need SQL-level aggregation or cursor-based pagination.
4. **Missing `ON DELETE CASCADE` for some FK relationships:** `citation_quotes` and `edit_logs` reference pages by `pageId` (text) but have no foreign key constraint to `wiki_pages.id`. If a page is renamed, orphaned records remain.
5. **No `updatedAt` trigger:** Tables have `updatedAt` columns but rely on application code to set them via `sql\`now()\``. A Postgres trigger would be more reliable.

---

## Recommended Priority Order

| # | Opportunity | Impact | Effort | Priority |
|---|---|---|---|---|
| 1 | Shared dashboard API fallback utility | DRY, fewer bugs | Low (1-2hr) | **Do first** |
| 2 | Migrate search to Postgres FTS | -1MB bundle, better search | Medium (4-6hr) | **High** |
| 3 | Facts to Postgres | Temporal queries, API access | Medium (6-8hr) | **High** |
| 4 | Entities to Postgres | Core data in DB, API access | Medium-High (8-12hr) | **High** |
| 5 | Edit log consolidation (drop YAML) | -625 files, simpler build | Low (2-3hr) | **Medium** |
| 6 | Session log consolidation | Simpler build | Low (2-3hr) | **Medium** |
| 7 | Auto-update news to Postgres | Consistency | Low-Medium (3-4hr) | **Medium** |
| 8 | Client library cleanup | Better error handling | Medium (4-6hr) | **Medium-Low** |
| 9 | Shared API types | Type safety | Low (2-3hr) | **Low-Medium** |
| 10 | Replace database.json entirely | Major simplification | Very High (weeks) | **Long-term** |

---

## Summary

The Postgres migration is well-executed and follows good engineering practices. The dual-write pattern is sound for a gradual migration. The most impactful near-term work is:

1. **DRY up the dashboard fallback pattern** (quick win, reduces bug surface)
2. **Move search to Postgres FTS** (user-facing improvement, smaller bundle)
3. **Add facts and entities to Postgres** (unlocks API-driven data access for the core data model)
4. **Consolidate edit logs to Postgres-only** (removes 625 files from the repo)

The long-term goal of eliminating `database.json` entirely is achievable once the core data types are in Postgres, but it's a multi-week project that should follow the incremental pattern established by the recent PRs.

# Design: PG-Native Resources & Unified ID System

**Status**: Draft proposal

**Last updated**: 2026-03-10

## Problem Statement

Resources currently live in 10 YAML files (`data/resources/*.yaml`, ~1000 entries) that are synced to PostgreSQL via `crux wiki-server sync-resources`. This YAML-first approach doesn't scale: we want to store many more resources at varying levels of richness, and the KB system has its own parallel ID namespace with no clean bridge.

Three ID systems coexist without a unified resolver:
- **Entity IDs**: `E<number>` (sequential, PG-backed via `entity_ids` table)
- **KB stableIds**: 10-char alphanumeric random strings (e.g., `mK9pX3rQ7n`)
- **Resource IDs**: 16-char hex hashes of URLs (e.g., `683aef834ac1612a`)

We want PG as the source of truth for resources, random IDs as the universal reference format, and a single resolver that handles all ID types.

## Goals

1. **Research pipeline queries DB resources first** — before hitting web search APIs, check what we already have
2. **Auto-register every URL** the system touches as a bare resource in PG — the DB grows with every research run
3. PG `resources` table becomes the canonical store (not YAML)
4. Resources get random stable IDs in the same format as KB stableIds
5. A unified ID resolver can look up any entity, KB thing, or resource by any of its IDs
6. Resources exist on a spectrum from bare URLs to full wiki-page entities
7. Small YAML override files remain for ad-hoc data that doesn't warrant a DB column

## Non-Goals

- Merging KB YAML files into PG (KB things stay as curated YAML)
- Eliminating entity numeric IDs (E-numbers stay for URL routing)
- Changing the `<R>` component API (it still takes an `id` prop)

---

## Current Architecture

### Data Flow (today)

```
data/resources/*.yaml          (source of truth)
       │
       ├──► build-data.mjs ──► database.json ──► frontend (SSR, zero API calls)
       │
       └──► crux wiki-server sync-resources ──► PG resources table ──► wiki-server API
```

### Who Reads Resource YAML Directly

| Consumer | File | What It Does |
|----------|------|--------------|
| Build pipeline | `apps/web/scripts/build-data.mjs` | Loads resources into `database.json` |
| Validation gate | `crux/lib/rules/resource-ref-integrity.ts` | Verifies `<R id="...">` references |
| KB schema validation | `crux/validate/validate-yaml-schema.ts` | Verifies `sourceResource` references |
| Resource lookup cache | `crux/lib/search/resource-lookup.ts` | `getResourceById()`, `getResourceByUrl()` |
| Resource I/O | `crux/resource-io.ts` | `loadResources()`, `saveResources()` |
| Resource manager | `crux/resource-manager.ts` | CLI commands (list, create, process, enrich, etc.) |
| Citation registration | `crux/citations/register-resources.ts` | Auto-creates resources from footnotes |
| Citation backfill | `crux/citations/backfill-resource-ids.ts` | Links citation_quotes to resource IDs |
| KB source-resource populator | `packages/kb/scripts/populate-source-resources.ts` | Auto-fills `sourceResource` on KB facts |
| URL-to-resource mapper | `apps/web/scripts/lib/unconverted-links.mjs` | Detects unconverted markdown links |

### Where Hex Hash IDs Are Hardcoded

- **MDX pages**: `<R id="683aef834ac1612a" />` — hundreds of inline references across ~600 pages
- **KB YAML**: `sourceResource: 683aef834ac1612a` — in ~30 KB thing files
- **PG tables**: `resources.id`, `resource_citations.resource_id`, `citation_quotes.resource_id`, `claim_sources.resource_id`, `citation_content.resource_id`, `page_citations.resource_id`, `statement_citations.resource_id` — all FK chains reference the hex hash
- **Resource YAML**: `id: 683aef834ac1612a` — the primary key in every resource record

---

## Proposed Architecture

### Data Flow (proposed)

```
PG resources table              (source of truth)
       │
       ├──► build-data.mjs fetches from wiki-server API ──► database.json ──► frontend
       │
       ├──► crux commands query wiki-server API (or local snapshot fallback)
       │
       └──► small YAML override files (ad-hoc fields only, merged at build time)
```

---

## Phased Migration Plan

### Phase 1: Add `stable_id` Column to PG Resources

Add `stable_id TEXT UNIQUE` column to `resources` table. Backfill existing rows with `generateStableId()` (same 10-char alphanumeric format as KB). New resources get a stableId on creation.

```sql
ALTER TABLE resources ADD COLUMN stable_id TEXT UNIQUE;
CREATE UNIQUE INDEX idx_res_stable_id ON resources(stable_id);
```

All resource API responses include `stableId`. The upsert preserves the first-written stableId:

```sql
ON CONFLICT (id) DO UPDATE SET
  stable_id = COALESCE(resources.stable_id, EXCLUDED.stable_id),
  ...
```

**Risk**: Low. Additive column, no existing behavior changes.

### Phase 2: Build Pipeline Reads from PG

`build-data.mjs` fetches resources from the wiki-server `/api/resources/all` endpoint instead of reading YAML files. A `data/resources-snapshot.json` file (git-tracked, periodically regenerated via `crux resources snapshot`) provides offline fallback. Build tries wiki-server first, snapshot second, existing YAML third.

`database.json` output shape is unchanged — frontend code is unaffected.

Publications stay as YAML (`data/publications.yaml`) for now (~30 entries, rarely change).

**Risk**: Medium. Build now depends on wiki-server availability (mitigated by fallback chain).

### Phase 3: Migrate Crux Commands to PG-First

All crux commands that currently call `loadResources()` from YAML switch to querying the wiki-server API. Each gains an `--offline` fallback that reads the snapshot file.

Affected: `resource-io.ts`, `resource-lookup.ts`, `resource-manager.ts`, `resource-ref-integrity.ts`, `register-resources.ts`, `backfill-resource-ids.ts`, `validate-yaml-schema.ts`, `populate-source-resources.ts`.

**Risk**: Medium. Many files, but each change is mechanical (YAML read → API call).

### Phase 4: Unified ID Resolver

New function in `apps/web/src/data/database.ts`:

```typescript
type ResolvedId =
  | { type: 'entity'; slug: string; numericId: string }
  | { type: 'kb-thing'; slug: string; stableId: string }
  | { type: 'resource'; id: string; stableId: string }
  | null;

function resolveAnyId(id: string): ResolvedId
```

Resolution order:
1. `E<number>` pattern → entity numeric ID lookup
2. `f_` prefix → fact ID
3. `i_` prefix → item ID
4. Check entity slug index (exact match)
5. Check KB stableId index
6. Check resource stableId index
7. Check resource hex hash index (backwards compat)

Build-time: `database.json` gains a `unifiedIdIndex` that merges all ID spaces.

**Risk**: Low. Additive, no existing behavior changes.

### Phase 5: Migrate References from Hex Hash to StableId (Optional)

Hundreds of MDX files contain `<R id="hex">` and ~30 KB files contain `sourceResource: hex`. Three options:

**Option A (recommended): Keep both formats.** The resolver handles hex and stableId. New references use stableId. Existing references remain valid indefinitely. No migration of MDX/KB files needed.

**Option B: Bulk rewrite.** Script maps hex→stableId from PG, rewrites all MDX and KB files. Large diff, merge conflict risk, but results in a clean single-format codebase.

**Option C: Gradual migration.** Resolver handles both. `crux resources process` emits stableIds for new conversions. Existing references rewritten opportunistically when pages are edited.

### Phase 6: Resource Enrichment Spectrum

No schema change — just filling in more columns. Resources naturally tier by richness:

| Level | What's Populated |
|-------|-----------------|
| **Bare** | `id`, `url`, `stable_id` |
| **Basic** | + `title`, `type` |
| **Summarized** | + `summary`, `authors`, `published_date`, `tags` |
| **Reviewed** | + `review`, `key_points`, `credibility_override` |
| **KB-linked** | KB thing exists with `sourceResource` pointing here |
| **Full entity** | `numericId` allocated, wiki page exists |

The existing `importance` column (0-100) can drive enrichment priority.

---

## Query Layer Integration (Primary Motivation)

The biggest payoff of PG-native resources isn't the storage migration — it's making the research pipeline **DB-first**. Today, the research agent treats the resource DB as a passive metadata layer. It searches the web, fetches URLs, and only then checks "oh, we already had this one." The resource DB should be the first place agents look, not the last.

### Current Research Flow (web-first)

```
research-agent.ts
  → Exa / Perplexity / SCRY  (web search, costs money, slow)
      → source-fetcher.ts  (fetch each URL)
          → resource-lookup.ts  (check: "do we already have this?")
              → attach metadata if found
  → section-writer  (LLM rewrites sections with sources)
```

The resource check is an afterthought — it runs per-URL after web search has already happened. The research agent has no concept of "what sources do we already have for this topic?"

### Proposed Research Flow (DB-first)

```
research-agent.ts
  1. Query PG: GET /api/resources/search?q=<topic>
     → "We already have 12 resources about alignment with summaries and reviews"
  2. Query PG: GET /api/resources/by-page/:pageId
     → "This page already cites 8 resources"
  3. Pre-populate SourceCacheEntry[] with known resources
     → These become preferred citations (already reviewed, higher trust)
  4. Identify gaps: "We have papers from 2023-2024 but nothing from 2025"
  5. THEN search web (Exa/Perplexity/SCRY) to fill gaps
  6. Deduplicate web results against DB resources (by URL)
  7. Auto-register new URLs as bare resources in PG
     → They start at the bottom of the enrichment spectrum
     → Future runs find them immediately
```

### Concrete Changes

#### 1. `research-agent.ts` — DB-first source discovery

Before calling Exa/Perplexity/SCRY, the research agent queries the wiki-server for existing resources. These are injected into the source cache as pre-trusted entries.

```typescript
// New: query DB resources before web search
const dbResults = await searchResources(topic);       // /api/resources/search
const pageResources = await getResourcesByPage(pageId); // /api/resources/by-page
const knownSources = [...dbResults, ...pageResources]
  .map(r => toSourceCacheEntry(r, { trusted: true }));

// Existing: web search fills gaps
const webResults = await runWebSearch(topic, { exclude: knownSources.map(s => s.url) });

// Merge: DB resources first, web results second
return [...knownSources, ...webResults];
```

**Key detail**: DB resources get a `trusted: true` flag (or equivalent priority score) so the section-writer prefers them for citations over freshly-discovered web results.

#### 2. `section-writer` — Prefer DB resources for citations

When the LLM rewrites a section and needs to cite sources, the prompt should indicate which sources are already in the wiki's resource library (reviewed, trusted) vs. freshly discovered (unverified). The writer should prefer DB resources when both cover the same claim.

#### 3. `source-fetcher.ts` — Auto-register new resources

When the fetcher encounters a URL that's not in the DB, it auto-creates a bare resource record:

```typescript
// After successful fetch of unknown URL:
await upsertResource({
  id: hashId(url),       // existing hex hash function
  url,
  title: extractedTitle,
  type: guessResourceType(url),
  fetchedAt: new Date().toISOString(),
});
```

This means every URL the system touches gets registered. Future research for the same topic immediately finds it in the DB — no re-fetching needed.

#### 4. `context for-page` — Include resource library

`crux context for-page <id>` should include the page's resource library so agents know what sources already exist:

```markdown
## Resources (12 cited)
- [683aef...] "Constitutional AI" (paper, arxiv.org) — reviewed, credibility: 5
- [926e4c...] "Anthropic Revenue Report" (blog, pminsights.com) — summarized
- ...
```

#### 5. Auto-update page router — Resource-aware routing

When routing news to pages, the page router could check if the news URL matches an existing resource that's already cited by a page. If so, the page might not need updating (the source is already incorporated).

### Why This Matters

Today: ~1000 resources exist but are barely used during research. The content pipeline rediscovers the same sources via web search every time it runs. Each web search costs API credits and adds latency.

After: The DB accumulates every URL the system touches. Each research run is faster and cheaper because known sources are found instantly. Resources that get cited across multiple pages build up reviews, key_points, and credibility scores — creating a growing library that makes the wiki more authoritative over time.

The enrichment spectrum (bare → basic → summarized → reviewed → KB-linked → full entity) means this happens naturally: a URL starts as a bare record when first discovered, gets a summary when first cited, gets a review when an improve run processes it deeply, and eventually becomes a full KB-linked resource if it's important enough.

---

## Technical Challenges & Bottlenecks

### 1. Build-time dependency on wiki-server

**Problem**: `pnpm build` currently reads YAML from disk — fast and offline. PG-first means needing a running wiki-server.

**Mitigation**: Three-tier fallback: wiki-server API → `data/resources-snapshot.json` → YAML files. CI always uses live PG. Local dev works offline via snapshot.

**Residual risk**: Snapshot can drift from PG. Acceptable for dev; CI always uses live data.

### 2. FK cascade on `resources.id`

**Problem**: The hex hash `id` is the PK referenced by 7+ FK columns across `resource_citations`, `citation_quotes`, `citation_content`, `claim_sources`, `page_citations`, `statement_citations`, `facts.source_resource`. Changing the PK format is a massive migration.

**Decision**: Don't change the PK. Keep hex `id` as PK. Add `stable_id` as a separate unique column. The unified resolver maps stableId → hex id internally.

### 3. Resource creation flow

**Problem**: `crux resources create <url>` generates `SHA256(url).slice(0,16)` and writes YAML. In the new world, it POSTs to the wiki-server.

**Change**: The `hashId(url)` function still generates the hex `id`. The API also generates a `stableId`. Both are returned. The `<R>` component can use either.

### 4. YAML override merging

**Problem**: Some resource data is ad-hoc and doesn't fit DB columns.

**Design**: A small `data/resource-overrides.yaml` keyed by resource ID:
```yaml
683aef834ac1612a:
  custom_notes: "This paper was retracted in 2025"
```

Build pipeline merges PG data with YAML overrides. YAML values win for override fields, allowing humans to correct AI-generated summaries without touching PG.

**Open question**: Should overrides be able to override any PG field? Or only dedicated override fields?

### 5. Offline development

**Problem**: Not everyone has wiki-server access.

**Mitigation**: `data/resources-snapshot.json` (committed, periodically updated) provides offline access. `crux resources` commands gain `--offline` flag. Validation runs against snapshot. Only write operations require wiki-server.

### 6. Concurrent resource creation

**Problem**: Multiple agents might create the same resource simultaneously.

**Mitigation**: Existing `ON CONFLICT DO UPDATE` upsert on `resources.id` is idempotent (same URL → same hex hash). StableId must use `COALESCE(existing, new)` to preserve the first-written value.

### 7. `<R>` component resolution

**Problem**: The `<R id="...">` component calls `getResourceById(id)` — an O(1) map lookup in `database.json`.

**No change needed**: `database.json.resources` has the same shape regardless of source (YAML or PG). To support `<R id="stableId">`, the resource index map also keys by stableId.

### 8. KB `sourceResource` references

**Problem**: ~30 KB files have `sourceResource: <hex-hash>`.

**No change needed in Phases 1-4**: The hex hash remains the PG PK. KB facts continue to work. Phase 5 (bulk rewrite) could optionally migrate these to stableIds.

---

## Open Questions

1. **Should `stable_id` ever become the PK?** Changing PK requires rewriting all FKs — probably not worth it. Keep hex `id` as PK, stableId as alias.

2. **What goes in YAML overrides vs PG columns?** Rule of thumb: if >10 resources need a field, add a PG column. If truly one-off, use override.

3. **Do resources get E-numbers automatically?** Probably explicit-only — most resources don't need wiki pages.

4. **Should the unified resolver be build-time (in `database.json`) or runtime (query PG)?** Build-time for frontend (fast, offline). Runtime for crux commands (always fresh).

5. **Does `<R>` eventually merge with `<EntityLink>` into a universal `<Ref>` component?** Or keep them separate with different visual treatments?

6. **When does `data/resources/*.yaml` get deleted?** After Phase 3 stabilizes and we're confident the PG→snapshot→build chain works reliably. Keep as seed data / emergency fallback until then.

# Things Denormalization Audit

**Ticket**: [QUA-414](https://linear.app/quantifieduncertainty/issue/QUA-414) — Phase 4b-A of [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408)
**Deliverable type**: audit-only (no code changes)
**Author**: Claude Code (slot a6), 2026-04-13

> **Status (2026-04-24)**: **RESOLVED.** Phase 4b-B.2c ([QUA-507](https://linear.app/quantifieduncertainty/issue/QUA-507)) dropped `things.title` / `things.description` / `things.parent_title` in migration 0204 and converted `upsertThingsInTx` to pointer-only. Display fields now live exclusively in the `things_search` materialized view (see migration 0190). The 22 write sites collapse to a single pointer-only writer. A gate validator (`validate-things-denorm-dead`) blocks reintroduction.
>
> This document is retained for historical reference — to understand which composer logic lived in which handler pre-QUA-507 (useful if the MV's per-thing_type composition ever needs to change).

## Purpose

Enumerate every denormalized / derived column on the `things` table, every write site, and every consumer, so Phase 4b-B can safely replace write-time denormalization with read-time resolution.

**Scope**: read-only survey. No handler was modified. Bugs found are listed in §6 and either filed as follow-up tickets or flagged for inclusion in 4b-B's plan.

## 1. Column inventory — the `things` table

Defined at `apps/wiki-server/src/schema.ts:2578`.

| Column | Type | NULL? | Classification | Notes |
|---|---|---|---|---|
| `id` | text | PK | identity | `stableId` or composite key per source type |
| `thing_type` | text | NOT NULL | identity | enum in `VALID_THING_TYPES` (line 2553) — 20 values |
| `title` | text | **NOT NULL** | **DERIVED (cache)** | composed at write-time from source row (+ entity JOIN) in ~21 handlers |
| `parent_thing_id` | text | null | pointer | FK → `things.id`. **Deliberately skipped on conflict** (`upsertThingsInTx`, line 192–204). Never updated after initial insert. |
| `source_table` | text | NOT NULL | identity | unique idx with `source_id` |
| `source_id` | text | NOT NULL | identity | primary source pointer |
| `entity_type` | text | null | normalized copy | for `entity` things, copied from `entities.entity_type`. Stale on entity type changes. |
| `description` | text | null | **DERIVED (cache)** | composed at write-time in ~15 handlers |
| `source_url` | text | null | normalized copy | from upstream `source`, `url`, `website` field |
| `wiki_id` | text | null | normalized copy | entity `E<N>` number |
| `parent_title` | text | null | **DERIVED (cache)** | resolved at write-time via `resolveEntityTitles` in ~11 handlers; missing in ~10 |
| `created_at` / `updated_at` / `synced_at` | timestamp | NOT NULL | metadata | auto-managed |
| `search_vector` | tsvector | generated | **DERIVED (computed)** | `GENERATED ALWAYS AS ... STORED` — see §1.1 |

### 1.1 search_vector — the constraint that shapes Phase 4b-B

Migration `0113_things_search_vector_add_type.sql`:

```sql
ALTER TABLE things ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(parent_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english',
      coalesce(replace(thing_type, '-', ' '), '') || ' ' ||
      coalesce(replace(entity_type, '-', ' '), '')
    ), 'D')
  ) STORED;
CREATE INDEX idx_things_search ON things USING GIN(search_vector);
```

**Implication for normalization**: `title`, `parent_title`, and `description` cannot simply be dropped without first replacing `search_vector`. PostgreSQL generated columns can only reference same-row values — we cannot compute `search_vector` via a JOIN. Three options for Phase 4b-B:

1. **Materialized view** with its own `title`/`description`/`parent_title` + generated `search_vector` + GIN index; refreshed on cron. Staleness becomes observable (refresh interval). This is the option QUA-408 Problem 1 recommends.
2. **Trigger-maintained column** on `things` that rebuilds `search_vector` when upstream entity/source rows change. Adds complexity to every upstream write path.
3. **Separate `things_search` table** with (id, search_vector) and upstream-triggered upserts. Decouples search from the canonical `things` row.

Option 1 is the only one consistent with the QUA-408 north star ("observable staleness, not silent drift"). Note: `things.ts::/search` also has an ILIKE + trigram fallback on `things.title` / `things.description` (lines 210–212, 269), so any replacement must support `similarity()` and `ILIKE` over the same fields, or the fallbacks need to move to the new layer.

## 2. Write sites

**22 write paths** — 20 source files, one of which (`political-races.ts`) has two handlers. Plus the reconciliation script and the one-shot backfill migration.

### Cluster A — direct `upsertThingsInTx` callers (9 handlers)

| # | Handler | Thing type | Title pattern | Raw-ID leak? | Missing fields | Notes |
|---|---|---|---|---|---|---|
| 1 | `entities.ts:983` | `entity` | `e.title` (authoritative) | no | parentThingId/parentTitle (correct — root) | Reference implementation. |
| 2 | `facts.ts:571` | `fact` | `${f.label \|\| f.factId} — ${titleMap.get(f.entityId) ?? f.entityId}` | **yes** (factId, entityId slug) | parentTitle (never set despite having entityId) | QUA-397 root cause. Fallback chain ends in raw `f_` ID when label is null. |
| 3 | `grants.ts:742` | `grant` | `g.name` | no in title | parentThingId | `parentTitle` / `description` fall back to raw `organizationId` / `granteeId` slugs. `description` hardcodes `$` currency symbol — wrong for non-USD. |
| 4 | `personnel.ts:442` (postUpsert hook) | `personnel` | `${personName} — ${role} at ${orgName}` with 4-step fallback | **yes** at last resort | parentThingId, parentTitle | personName fallback: `titleMap[personEntityId]` → `personDisplayName` → `cleanPersonId(personId)` → `personId` (which can be `sid_...` slipping through `cleanPersonId`'s null). Single route with postUpsert hook. |
| 5 | `equity-positions.ts:316` | `equity-position` | `${titleMap[holderId] ?? holderId} stake in ${titleMap[companyId] ?? companyId}` | **yes** (slugs) | parentThingId, parentTitle, description | |
| 6 | `political-races.ts:488` (race candidates) | `race-candidate` | `item.candidateDisplayName` (authoritative) | no | parentTitle (could be race name) | parentThingId is set to `raceId`. |
| 7 | `entity-resources.ts:125` | `entity-resource` | `resourceTitleMap[resourceId] ?? resourceId` | **yes** (falls to raw resource ID — legacy 16-char hex per QUA-407) | parentThingId, sourceUrl | **`entity-resource` is NOT in `VALID_THING_TYPES`** (see §6 bug #1). |
| 8 | `resources.ts` (wikibase) `:581` | `resource` | `r.title \|\| r.url` | no (falls to URL) | parentThingId, parentTitle | Clean fallback. Also writes its own `resources.search_vector` separately (lines 571–578). |
| 9 | `things.ts:543` (factory, self-sync via `/api/things/sync`) | _any_ | caller-supplied | n/a | **drops `parentTitle` silently** (Zod accepts it but `toRow` omits it) | See §6 bug #9. Only used by `crux/wiki-server/sync-things.ts` today, for entity + resource types. |

### Cluster B — `sync-factory.ts` `toThing` callbacks (13 handlers, 12 files)

All of these go through `sync-factory.ts:661–672`: the factory calls `resolveEntityTitles` for IDs returned by `thingsTitleIds`, then invokes `toThing(item, titleMap)`, then `upsertThingsInTx(tx, thingsRows)`.

| # | Handler | Thing type | Title pattern | Raw-ID leak? | Missing `thingsTitleIds`? | Notes |
|---|---|---|---|---|---|---|
| 10 | `entity-assessments.ts:101` | `entity-assessment` | `${item.dimension}: ${item.rating}` | no | no (`entityId` resolved) | `parentTitle` falls back to raw slug. |
| 11 | `research-areas.ts:428` | `research-area` | `item.title` (authoritative) | no | — | **Passes `href` field that is silently dropped** (`ThingSyncInput` has no `href`). See §6 bug #2. |
| 12 | `investments.ts:297` | `investment` | `${item.investorId} → ${item.companyId}${roundName ? ` (${roundName})` : ""}` | **yes** (raw slugs) | **yes — no `thingsTitleIds`** | Titles look like `open-philanthropy → anthropic` not `Open Philanthropy → Anthropic`. |
| 13 | `policy-stakeholders.ts:119` | `policy-stakeholder` | `${item.stakeholderDisplayName} on ${titleMap[policyEntityId] ?? policyEntityId}` | yes (slug fallback) | no (`policyEntityId` resolved) | |
| 14 | `benchmark-results.ts:183` | `benchmark-result` | `${item.modelId} on ${item.benchmarkId}: ${item.score}` | **yes** (raw slugs) | **yes — no `thingsTitleIds`** | Same pattern as investments. |
| 15 | `benchmarks.ts:144` | `benchmark` | `item.name` (authoritative) | no | — | Clean. Uses `wikiId` to carry the slug for URL routing via `thingHref()`. |
| 16 | `entity-events.ts:115` | `entity-event` | `${item.title} (${item.date})` | no | no (`entityId` resolved) | `parentTitle` falls back to raw slug. |
| 17 | `divisions.ts:222` | `division` | `item.name` (authoritative) | no | no (`parentOrgId` resolved) | `parentTitle` falls back to raw slug. |
| 18 | `funding-rounds.ts:266` | `funding-round` | `item.name + (date ? ` (${date})` : "")` | no | no | `parentTitle` falls back to `companyDisplayName ?? companyId` (better — uses denormalized `companyDisplayName`). `description` hardcodes `$` currency. |
| 19 | `funding-programs.ts:306` | `funding-program` | `item.name` | no | no | `parentTitle` falls back to raw slug. |
| 20 | `division-personnel.ts:171` | `division-personnel` | `${item.personId} — ${item.role}` | **yes** (raw slug) | **yes — no `thingsTitleIds`** | |
| 21 | `publications.ts:166` | `publication` | `item.title` (authoritative) | no | no | `parentTitle` falls back to raw slug. |
| 22 | `political-races.ts:401` | `political-race` | `item.name` (authoritative) | no | n/a | `parentTitle` is set to `item.state` — not an entity, plain string (correct). |

### Non-handler write paths

| Path | When | Notes |
|---|---|---|
| `crux/wiki-server/sync-things.ts` | Manual reconciliation CLI (`pnpm crux wiki-server sync-things`) | Reads `data/entities/*.yaml` and `data/resources/*.yaml`, POSTs to `/api/things/sync`. Only handles `entity` + `resource` types. Parallel write path to the domain sync endpoints. |
| `apps/wiki-server/drizzle/0087_populate_things_from_domain_tables.sql` | One-shot backfill, historical | `INSERT ... ON CONFLICT DO NOTHING`. Inactive in steady state. |

### Cross-cutting observations on write sites

- **Title resolution is reimplemented ~21 times.** No shared "compose title for thing type X" helper. Every handler duplicates entity-title lookup, fallback logic, and string composition, with inconsistent separator choices (` — `, ` on `, ` at `, ` → `, `:`, ` stake in `).
- **`upsertThingsInTx` never updates `parentThingId` on conflict.** Lines 192–204: the `SET` clause omits it. Parent relationships that change post-creation will drift permanently.
- **No handler passes `parentThingId` as a proper `things.id`.** Several pass the entity slug or stableId (`f.entityId`, `item.entityId`, `item.policyEntityId`, `item.raceId`). `upsertThingsInTx` writes these values directly into the FK column; if they happen to match a `things.id` the FK holds, otherwise it's dangling until a later backfill. No runtime validation.
- **Raw-ID leak taxonomy**: the 8 handlers marked "raw-ID leak" fall into two subclasses:
  - **A** — entity slug leaks (`open-philanthropy` in titles/descriptions) — cosmetic but persistent
  - **B** — fact ID / stableId leaks (`f_xxx`, `sid_xxx`) — user-visible and actively being patched downstream (QUA-397, QUA-407)
- **`entity-resource` thing_type is not in the `VALID_THING_TYPES` enum.** `entity-resources.ts:129` writes it anyway. The schema doesn't enforce the enum with a CHECK — see §6 bug #1.
- **5 handlers compose title from raw slugs without calling `resolveEntityTitles`.** investments (#12), benchmark-results (#14), division-personnel (#20) via the factory; plus equity-positions (#5) and facts (#2) via direct calls that fall back to raw IDs when the lookup fails. These are the handlers where fixing the title at read time has the highest leverage.

## 3. Consumers

### Wiki-server (read paths)

| File:line | Reads | Surfaces | Notes |
|---|---|---|---|
| `routes/tablebase/things.ts:110–132 (formatThing), 138, 194, 210, 212, 226, 343, 420, 429, 452, 469, 478, 522, 531` | `title`, `description`, `parentTitle`, `search_vector` | `/api/things/*` — list, search, get-by-id, search-by-parent, etc. | **Primary consumer.** `formatThing()` returns `title`/`description`/`parentTitle` verbatim in all responses. Search uses `search_vector` for FTS, `title`/`description` for ILIKE fallback, `title` for trigram similarity. |
| `routes/tablebase/things.ts:271–310` (trigram fallback raw SQL) | same | `/api/things/search` phase 3 | Hand-written SQL selecting all derived columns. |
| `routes/tablebase/people.ts:218–311` | `title` AS name, `description`, `search_vector`, `wiki_id`, `source_id` | `/api/people` — directory listing used by `/people` | Queries `FROM things t WHERE thing_type = 'entity' AND entity_type = 'person'`. Sorts by `t.title`. FTS via `t.search_vector`. Trigram fallback via `similarity(t.title, …)`. |
| `routes/tablebase/entity-profile.ts:273` | all columns | `/api/entity-profile/...` → internal entity profile viewer | `SELECT * FROM things WHERE parentThingId = stableId LIMIT 2000`. Used to render the "Things" sub-section of an entity's profile page. |
| `routes/sourcing/sourcing.ts:1663–1679` | `title` | `/api/sourcing/resolve-names` fallback (non-wiki-page, non-publication, non-footnote) | Generic name resolver used by the sourcing dashboard and `/sourcing/*` pages to display record labels for verdicts. |
| `routes/sourcing/sourcing.ts:1968–1977` | `parent_thing_id` FK only (no title/description) | `/api/sourcing/entity-summary` | CTE joining `things t1 → things t2` on parent-thing relationship for record count aggregation. Not affected by title/description normalization. |
| `routes/operational/qa-checks.ts:162–186` | `title`, `entity_type`, `wiki_id`, `source_id` | `/api/qa-checks/queue` | QA sweep queue — entities that have been least-recently checked. |

### Frontend (apps/web) — user-visible

| File | Uses | Source |
|---|---|---|
| `app/things/[id]/page.tsx:367–474` | `thing.title`, `thing.description`, `thing.parentTitle` (direct render) | `/api/things/:id` via proxy |
| `app/things/things-table.tsx:171–230` | `row.title`, `row.parentTitle`, `row.description` | `/api/things` list |
| `app/people/people-table.tsx:25–571` | `row.name` (= `t.title`), `row.description` | `/api/people` |
| `components/SearchDialog.tsx` (via `lib/search.ts::searchThings`) | `result.title`, `result.description`, `result.parentTitle` | `/api/things-search` → wiki-server `/api/things/search` |
| `app/sourcing/[recordType]/[recordId]/page.tsx:323–529` | `resolvedName` (from `things.title` fallback) | `/api/sourcing-names-proxy` → wiki-server `/api/sourcing/resolve-names` |

### Frontend (apps/web) — indirect / metadata-only

| File | Uses | Notes |
|---|---|---|
| `app/internal/entity-profile/entity-profile-viewer.tsx:170,238,695–708` | Column exclusion list `parent_thing_id/source_table/source_id`; section label "Things"; `/things/<id>` linking | Doesn't read `title`/`description`/`parent_title` directly. |
| `app/factbase/fact/[factId]/page.tsx:404`, `app/factbase/record/[recordId]/page.tsx:159` | References to `packages/factbase/data/fb-entities/` (YAML dir) | **Unrelated** to PG `things` table — name collision only. |

### crux CLI / reconciliation

| File | Role | Notes |
|---|---|---|
| `crux/wiki-server/sync-things.ts` | writer (see §2) + reader of its own write | Uses `/api/things/sync` to reconcile entity + resource types from YAML. |
| `crux/commands/legislation/verify-stakeholders.ts` | reader | Calls `/api/things/*` (details TBD — not audited here; only `rg` confirmed URL references). |
| `crux/commands/legislation/auto-verify-stakeholders.ts` | reader | Same. |

### Public-route consumers — the hit list for Phase 4b-B

Any UI surface that would show a wrong/raw title on a title-only change:

- `/things` (list), `/things/[id]` (detail), `/things` table search
- `/people` directory (list + search + trigram typo tolerance)
- `/sourcing/:recordType/:recordId` detail pages (via resolve-names fallback)
- Site-wide search dialog "Things" tab
- Internal entity profile viewer → "Things" sub-section

## 4. Secondary audit — sibling derived columns

Phase 4b-A scope explicitly asks whether other columns have the same write-time-denormalization shape. Yes. Two separate patterns:

### 4.1 `*_display_name` columns — 13 tables, ~20 columns

Grepped from `schema.ts`:

| Table | Columns |
|---|---|
| `source_check_verdicts` | `display_name`, `entity_display_name` |
| `personnel` | `person_display_name`, `org_display_name` |
| `grants` | `org_display_name`, `grantee_display_name` |
| `funding_rounds` | `company_display_name`, `lead_investor_display_name` |
| `investments` | `company_display_name`, `investor_display_name` |
| `equity_positions` | `company_display_name`, `holder_display_name` |
| `funding_programs` | `company_display_name` |
| `division_personnel` | `person_display_name` |
| `publications` | `entity_display_name` |
| `entity_assessments` | `entity_display_name` |
| `research_area_people` / `...organizations` | `entity_display_name` |
| `policy_stakeholders` | `stakeholder_display_name` (NOT NULL) |
| `political_races` / `race_candidates` / `political_votes` / `political_offices` / `political_scores` / `campaign_finance` | `candidate_display_name`, `pac_display_name`, `politician_display_name`, etc. |

**How they're written**: `apps/wiki-server/src/routes/shared/resolve-entity-fks.ts::resolveEntityFKs()`.

**Semantics**: A `*_display_name` is a **fallback name for unresolved FK references**. The helper only populates it when the FK resolution fails (`WHERE t.<entityCol> IS NULL AND t.<displayCol> IS NULL`, line 119). When FK resolution succeeds, `display_name` is left untouched — either NULL (the common case) or whatever value an earlier failing attempt had written.

**This is worse than `things.title`** in one dimension:

- `things.title` is re-written on every sync (via `onConflictDoUpdate SET title = excluded.title`). Stale-but-updateable.
- `*_display_name` is **set-once** at the moment FK resolution first fails. Never refreshed when the upstream entity title changes. Permanent cache.

**Evidence it has caused real incidents**: migration `0170_investments_display_name_dedup.sql` (#3353) had to deduplicate investment rows that bypassed the unique constraint because the constraint checked `(investor_entity_id, company_entity_id, round_name)`, which was NULL for unresolved rows, so `Y Combinator` and `y-combinator` variants created duplicate rows. The fix: a unique index on `LOWER(COALESCE(entity_id, raw_id))` — i.e., leaning on the display_name fallback instead of fixing it.

**Recommendation for Phase 4b-B**: treat `*_display_name` as part of the same normalization effort. When FK resolution succeeds, the consumer should JOIN `entities`; when it fails, the consumer should be shown the raw ID with a visible unresolved-state indicator. Eliminating the column entirely is preferable to keeping a permanent stale cache.

### 4.2 `facts.label` — legacy fact label cache

`schema.ts:962`: `label: text("label")` — nullable column on `facts`.

**Authoritative source**: the FactBase property definition (`packages/factbase/data/fb-entities/<entity>.yaml` references property keys that live in `packages/factbase/src/properties.ts` or equivalent). At sync time, `facts.ts` copies `property.name` into `facts.label`.

**Used by**: `facts.ts:284` (select for API export), `sourcing.ts:1531` (resolve fact names for sourcing dashboard). Crucially, `facts.ts:575` uses `label || factId` as the thing title — this is the QUA-397 leak entry point.

**Staleness mode**: if a FactBase property is renamed (e.g. `revenue_2023` → `revenue-2023`), `facts.label` across all rows remains with the old name until `sync-facts.ts` is re-run and every row's label is overwritten by the new `excluded.label`. Unlike `*_display_name`, `facts.label` IS refreshed on every sync — so staleness is bounded by sync cadence, not unbounded.

**Classification**: cache-with-refresh, not set-once. Less urgent than `*_display_name` but still a cache that can drift between syncs.

### 4.3 Other derived columns worth flagging but not in 4b-B scope

- `entities.title` — **authoritative, not a cache**. This is the source-of-truth for entity titles; every other derived column pulls from it.
- `things.entity_type` — copied from `entities.entity_type`. Stale on type changes, but entity type changes are rare and covered by the full-sync path.
- `things.wiki_id` — copied from `entities.wiki_id` (and from benchmark/research-area slugs in a confusing overload — see `benchmarks.ts:152` which stores the slug in `wikiId`). Correctness-critical for `thingHref()` routing; worth a separate inventory in Phase 4b-C.
- `things.source_url` — copied from upstream `source`/`url`/`website`. Stale on URL changes, but URL changes are rare.
- Resource caching: `resources.search_vector` is its own GENERATED column from `title`/`summary`/`abstract`/`review` (separate from `things.search_vector`). Out of scope for 4b-B but worth noting — two parallel FTS systems over the same `resource` rows.

## 5. Sync-handler escape hatches already baked into the architecture

The factory-based handlers (Cluster B) have three optional hooks that map directly onto denormalization concerns:

- **`thingsTitleIds`** — which entity IDs to resolve for `parentTitle`. Missing for 5/13 factory handlers (see §2 Cluster B table).
- **`toThing`** — the thing row composer. Currently a pure function of `(item, titleMap)`. For Phase 4b-B, this would either (a) be deleted entirely (things derives at read time) or (b) reduced to a pure identity pointer: `{ id, thingType, sourceTable, sourceId, parentThingId }`.
- **`postUpsert`** — a general-purpose post-commit hook. `personnel.ts` uses it to do a re-fetch + re-resolve of person/org titles because `fkResolve` runs between upsert and `toThing`.

The hook budget rule ("max 1 per route", per `docs/agent-rules/tablebase-sync-factory.md`) means personnel is already at its limit. When 4b-B lands, personnel's `postUpsert` should be deletable.

## 6. Findings — bugs, gaps, and inconsistencies discovered during audit

Numbered so they can be referenced in follow-up tickets. Each includes a file:line citation.

1. **`entity-resource` thing_type is not in `VALID_THING_TYPES`** — `entity-resources.ts:129` writes `thingType: "entity-resource"` but the enum at `schema.ts:2553–2574` does not contain this value. No CHECK constraint enforces the enum, so writes succeed. All `VALID_THING_TYPES.includes()` callers (if any) will reject it. Candidate for a gate check or runtime validation. **Disposition**: file follow-up ticket (low/medium severity).

2. **`research-areas.ts:428` passes an `href` field that is silently dropped** — `ThingSyncInput` has no `href` field, so the value is lost. Intent was presumably to pass the route prefix; in practice, `thingHref()` computes it at read time, so the dropped field is moot, but it's a sign the author didn't verify the helper contract. **Disposition**: file follow-up ticket (trivial, clean-up class).

3. **`facts.ts:575` title fallback ends in raw `f_` fact ID** — `const factLabel = f.label || f.factId; ... title: `${factLabel} — ${entityName}`. This is the exact bug pattern QUA-397 identified. The fix is either (a) reject writes where label is null, or (b) compose titles at read time in 4b-B. **Disposition**: **subsumed by QUA-408 Phase 4b-B** — no separate ticket; already flagged in QUA-397 / QUA-408 tracking. Document here as the most expensive instance of the general pattern.

4. **`facts.ts:571` writes `parentThingId: f.entityId` but never sets `parentTitle`** — unlike personnel (which also skips it) and entity-events (which resolves it), facts don't resolve their parent entity name into the `parent_title` column. This means `things.search_vector` for fact rows does not include the parent entity name, reducing search relevance — a fact like "Revenue: $1B" won't match a query for the parent org name via FTS. **Disposition**: **subsumed by 4b-B** (read-time resolution eliminates the column entirely). Noted.

5. **5 factory handlers have no `thingsTitleIds` — titles contain raw slugs** — investments.ts, benchmark-results.ts, division-personnel.ts, and (partially) equity-positions.ts/facts.ts. Search still works because `search_vector` is rebuilt from the stored title, but the stored title displays raw slugs to users. **Disposition**: **subsumed by 4b-B** as a class. Don't file individual tickets — the right fix is to kill the column, not to add `thingsTitleIds` callbacks to each handler.

6. **`things.ts:543 /sync` drops `parentTitle` silently** — the Zod schema at line 157 accepts `parentTitle`, but `toRow` at 553–564 and `conflictSet` at 566–577 both omit it. Any client posting `parentTitle` through `/api/things/sync` will have it silently written as NULL. Current only caller (`crux/wiki-server/sync-things.ts`) doesn't send it, so no observable bug today — but a latent pit-of-despair for future callers. **Disposition**: file follow-up ticket (silent-schema-mismatch class, QUA-408 Phase 4 validator classification candidate).

7. **`upsertThingsInTx` never updates `parent_thing_id` on conflict** — `thing-sync.ts:192–204`: the conflict `SET` clause deliberately omits `parentThingId` with the comment "it's backfilled by migration 0087 and rarely changes". This means parent relationship changes (e.g., a fact's owning entity changes) never propagate to `things.parent_thing_id`. If 4b-B computes parent titles at read time but keeps parent_thing_id as a stored FK, this drift needs to be re-examined. **Disposition**: flag for 4b-B planning; not a standalone ticket.

8. **`grants.ts:756` and `funding-rounds.ts:275` hardcode `$` currency** — `description: 'raised $' + Number(amount).toLocaleString()`. Grants and rounds in EUR, GBP, CNY are rendered with a `$` prefix. **Disposition**: file follow-up ticket (display correctness). Independent of the 4b-B normalization.

9. **`personnel.ts:448` can still return raw `sid_` in title** — `cleanPersonId()` returns null for `sid_*`, pushing the fallback chain to `personId`, which IS the `sid_`. Fixed only when `personDisplayName` is populated. QUA-397 regression class. **Disposition**: **subsumed by 4b-B** (read-time JOIN fixes this).

10. **Two parallel write paths for entity + resource things** — both `entities.ts:983` (on entity sync) and `crux/wiki-server/sync-things.ts` (reconciliation) populate the same rows. Keeping both alive is fine during migration; worth noting for 4b-B cutover planning.

## 7. Recommendations for Phase 4b-B

Priority-ordered, each cites the specific file:line that would change. This is an observations list, not a sequenced roadmap.

### P0 — necessary preconditions

1. **Design the `search_vector` replacement first.** Options in §1.1. Recommendation: materialized view `things_search` with its own denormalized `(title, parent_title, description, search_vector)` + GIN index + hourly refresh. This is the only part that can't just be "compute at read time" — PostgreSQL generated columns don't JOIN. Until this is decided, Phase 4b-B can't proceed. Cite for change: `apps/wiki-server/drizzle/0113_things_search_vector_add_type.sql` (delete the generated column), new migration to create the materialized view.

2. **Prototype the read-time resolver for one thing type first.** Start with `personnel` because it has the most painful composition (4-step fallback) and the most bugs. Build a `resolvePersonnelTitle(row, entityTitleMap)` helper and run it at query time. Measure: query latency for `/api/things/search?thing_type=personnel`, `/api/entity-profile/<id>` sub-section fetch, and `/people` directory listing. If acceptable, roll out to all 21 thing types. Cite for change: `apps/wiki-server/src/routes/shared/thing-sync.ts` (add resolver), `apps/wiki-server/src/routes/tablebase/things.ts:110–132` (replace `formatThing` with resolver).

### P1 — high-leverage refactors

3. **Consolidate the 21 title-composition patterns into a single dispatch table**, keyed by `thingType`. Each entry maps `(sourceRow, entityTitleMap) → { title, description, parentTitle }`. This replaces 21 hand-written composers with one table + 21 small functions. Even if Phase 4b-B keeps the columns, this step eliminates the "new bugs keep appearing because each handler is slightly different" failure mode. Cite for change: the 21 write sites listed in §2.

4. **Delete `upsertThingsInTx` as a `title`/`description`/`parent_title` denormalizer.** In Phase 4b-B it becomes a pointer-write helper: `{ id, thingType, sourceTable, sourceId, parentThingId? }`. Handlers stop calling `resolveEntityTitles` for the purpose of populating `parentTitle`. Cite for change: `apps/wiki-server/src/routes/shared/thing-sync.ts:143–206`, and every handler in §2.

5. **Drop the generated `search_vector` column** after the materialized view is in place. Same migration that creates the view should DROP the column. Cite for change: new migration file.

### P2 — clean-up, subsumed or blocked by the above

6. Fix findings #1 (bad `entity-resource` type), #2 (dropped `href`), #6 (silent `parentTitle` drop), #8 (hardcoded `$`) — file as independent tickets (see §8).

7. Add a validator that fails if any `thing_type` value in `things` is not in `VALID_THING_TYPES`. Rule: every enum used in a text column should have either a CHECK constraint or a blocking validator. This aligns with QUA-408 Phase 4's "schema constraint > write-path assertion > validator" hierarchy.

8. Decide on `*_display_name` in the same PR as `things.title`. They have the same failure shape, worse staleness, and 20 columns across 13 tables. Leaving them untouched while removing `things.title` trades one leak path for another.

### P3 — parking-lot / out of 4b-B scope

9. **Consolidate `resources.search_vector` with `things.search_vector`.** Two separate FTS systems over the same row is unnecessary. Out of 4b-B scope (it's its own migration), but worth a ticket for Phase 4b-D or 4c.

10. **`entities.title` and `entities.description` are the true authoritative source.** All derived columns should trace back to one of: `entities.{title,description}`, `resources.{title,summary}`, `facts.{label,value}`, `grants.name`, etc. A future audit could produce a graph of "what columns are authoritative vs derived" so we stop accidentally introducing new caches.

## 8. Follow-up tickets to file

Items that are NOT subsumed by Phase 4b-B and have been filed as independent Linear tickets. Cross-referenced from §6.

| # | Finding | Ticket | Severity |
|---|---|---|---|
| 6.1 | `entity-resource` thing_type not in `VALID_THING_TYPES` | **[QUA-433](https://linear.app/quantifieduncertainty/issue/QUA-433)** | low |
| 6.2 | `research-areas.ts` passes dropped `href` field | **[QUA-434](https://linear.app/quantifieduncertainty/issue/QUA-434)** | trivial |
| 6.6 | `/api/things/sync` silently drops `parentTitle` | **[QUA-435](https://linear.app/quantifieduncertainty/issue/QUA-435)** | medium |
| 6.8 | `grants.ts` / `funding-rounds.ts` hardcode `$` currency | **[QUA-436](https://linear.app/quantifieduncertainty/issue/QUA-436)** | medium |

Items **subsumed by Phase 4b-B** (no standalone ticket):

- 6.3 — facts.ts title fallback ends in raw `f_` ID (QUA-397 root cause; QUA-408 parent)
- 6.4 — facts.ts missing `parentTitle`
- 6.5 — 5 factory handlers embed raw slugs in title — fixing individually is wasted work if the column is going away
- 6.7 — `upsertThingsInTx` never updates `parent_thing_id` on conflict (flag for 4b-B planning)
- 6.9 — personnel.ts `sid_` fallback (subset of QUA-397)

---

## Method notes (for reviewers spot-checking the audit)

To verify the completeness claim, re-run these greps — all handlers in §2 should show up:

```bash
# Direct upsertThingsInTx callers:
rg -n 'upsertThingsInTx\s*\(' apps/wiki-server/src/routes

# Factory-based toThing callers:
rg -n 'toThing\s*[:=]' apps/wiki-server/src/routes

# Consumers reading title/description/parent_title:
rg -n 'things\.title|things\.description|things\.parent_title|things\.parentTitle' apps/wiki-server/src apps/web/src
rg -n 'FROM\s+things|from\(things\)' apps/wiki-server/src apps/web/src
```

If any file returned by those greps is not listed in §2 or §3, the audit is incomplete — please update.

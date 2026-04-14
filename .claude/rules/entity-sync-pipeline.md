# Entity-Sync / TableBase Pipeline

Subsystem map for the YAML → sync → PG pipeline and the tablebase route infrastructure. **Read this before writing a new sync endpoint, delete handler, or entity validation** — the shared helpers and factories are missed constantly.

> **If your new handler writes to `things.title` / `things.description` / `things.parent_title`, or adds a `*_display_name` column**: read `docs/audits/things-denormalization-audit.md` first. It enumerates all 22 existing write sites, the 5 handlers that leak raw IDs today (subsumed by [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Tier 4b), and the `search_vector` GENERATED column constraint that any replacement must preserve. Adding a 23rd bespoke title composer without reading the audit is the fastest way to recreate QUA-397.

## Why this file exists

Recent rework incidents in this subsystem include:
- **PR #4059** broke `unnest()` array parameterization across 8 endpoints — `sqlInList` helper existed but wasn't used
- **PR #4029** added `validateEntityRefs` calls to 8 endpoints that had silently been missing it
- **PR #4045** fixed an entity slug reassignment race
- **PR #4064** discovered **20+ tablebase routes had `/sync` but no `/delete-batch`** (systemic gap)
- **PR #4067** created a shared delete-handler factory after grants/funding-programs had duplicated 33-line hand-written handlers. **PR #4072** then ripped out the duplicates
- **PR #4000** consolidated duplicate personnel entity title queries

The common failure: "I didn't know that helper/factory existed." This file is the helper/factory inventory.

---

## 1. Shared helpers (the things that get missed)

All live in `apps/wiki-server/src/routes/shared/`:

| Helper | File | Purpose | Missed in |
|--------|------|---------|-----------|
| `sqlInList()` | `query-helpers.ts:170` | Parameterized `IN (...)` for array values; wraps `unnest()` correctly | PR #4059 (8 endpoints) |
| `validateEntityRefs()` | `validate-entity-refs.ts` | Batch FK check against `entities.id` and `entities.stable_id`; bypass-with-reason logging | PR #4029 (8 endpoints) |
| `findMissingEntityRefs()` | `validate-entity-refs.ts` | Returns unresolved refs without throwing | — |
| `shouldSkipEntityValidation()` | `validate-entity-refs.ts` | Migration-mode escape hatch | — |
| `resolveEntityFKs()` | `resolve-entity-fks.ts` | Post-upsert: resolves raw FK columns (slug/stableId) → `entities.stable_id`, backfills display names | Only 5 routes use it |
| `deleteBatchHandler()` | `delete-batch.ts` | **Factory for `/delete-batch` endpoints**. Deletes from domain table + `things` with FK-safe ordering. Options: `maxBatchSize`, `label`, `pkColumn`, `maxIdLength` | PR #4064 (6 routes still missing it) |
| `upsertThingsInTx()` | `thing-sync.ts` | Upserts `things` records inside domain transaction; resolves entity titles for `search_vector` | — |

**Before writing any delete endpoint**: use `deleteBatchHandler()`. Do not write a hand-rolled delete.
**Before writing any array-parameter query**: use `sqlInList()`. Do not write raw `unnest()`.
**Before any sync handler that takes entity refs**: call `validateEntityRefs()` first. Not calling it is a bug, not a style choice.

## 2. Sync orchestrators (`crux/wiki-server/sync-*.ts`)

Crux-side scripts that read YAML source and batch POST to wiki-server. All use `sync-common.ts` helpers.

| Script | Source | Target endpoint |
|--------|--------|-----------------|
| `sync-entities.ts` | `data/entities/*.yaml` | `/api/entities/sync` |
| `sync-facts.ts` | `packages/factbase/data/things/*.yaml` | `/api/facts/sync` |
| `sync-things.ts` | derived | `/api/things/sync` |
| `sync-pages.ts` | `content/docs/**/*.mdx` | `/api/pages/sync` |
| `sync-sessions.ts` / `sync-session.ts` | session logs | `/api/sessions/*` |
| `sync-assessments.ts` | assessments | `/api/assessments/sync` |
| `sync-benchmarks.ts` | benchmark YAML | `/api/benchmarks/sync` |
| `sync-auto-update-runs.ts` | auto-update logs | `/api/auto-update-runs/sync` |
| `sync-common.ts` | **shared infra** | `batchSync<T>()`, `waitForHealthy()`, `fetchWithRetry()`, health-check + exponential backoff + consecutive-failure tracking |

**Adding a new sync**: use `batchSync()` from `sync-common.ts`. Don't write your own batch loop.

## 3. Tablebase route inventory (40 routes)

All under `apps/wiki-server/src/routes/tablebase/`. Each route file is one PG table.

**Routes with BOTH `/sync` and `/delete-batch`** (23 — the baseline):
`grants`, `funding-rounds`, `investments`, `equity-positions`, `benchmarks`, `benchmark-results`, `funding-programs`, `entity-assessments`, `entity-resources`, `entity-events`, `research-areas`, `political-votes`, `political-offices`, `political-scores`, `policy-stakeholders`, `prediction-markets`, `publications`, `secondary-market-prices`, `website-sources`, `division-personnel`, `divisions`, `campaign-finance`, `data-sources`

**Read-only / utility routes** (no `/sync` or `/delete-batch` expected): `audit-log`, `ids`, `index`, `people`, `record-lookup`, `sourcing-schema`, `sync-factory` (types only), `talent-flows`, `write-inline-verdicts`.

**Routes still missing `/delete-batch` (PR #4064 gap)** (8):
- `bluesky.ts`
- `entities.ts`
- `entity-profile.ts`
- `entity-profile-descriptions.ts`
- `personnel.ts`
- `platform-accounts.ts`
- `political-races.ts`
- `things.ts`

If you're touching any of these, consider adding `deleteBatchHandler()` — it's a known gap. (Check first — one may have been added since this doc was written.)

## 4. Natural keys / upsert conflict targets

Most routes use `onConflictDoUpdate({ target: <table>.id, set: { ...excluded fields } })` with `id` as the natural key. Personnel may use composite `(personId, organizationId)`. **No shared upsert-builder factory yet** — each route hand-writes the `set:` clause. This is a candidate for a future `createUpsertHandler()` factory but doesn't exist today.

`validate-tablebase-completeness.ts` is the gate check that flags missing `/sync`, `/delete-batch`, and validation calls.

## 5. Concurrency / race patterns

- **Slug reassignment** (PR #4045 safe pattern): bulk UPDATE to clear stale slugs, then upsert on `stableId`, **both inside the same transaction**. See `entities.ts:~930-960` for the reference implementation. Displaced slugs get title-derived fallback with `-displaced` suffix.
- **ID allocation** (PR #4043): sequential, transaction-safe. Goes through wiki-server, not local.
- **Advisory locks**: used in `wikibase/links.ts` and `operational/build-metrics.ts` for page-level concurrency. Tablebase routes rely on transaction ordering, not explicit advisory locks.

## 6. Data flow (one diagram)

```
YAML source of truth           crux/wiki-server/sync-*.ts           apps/wiki-server/src/routes/tablebase/*.ts
  data/entities/*.yaml     →   batchSync() via sync-common.ts   →   upsert → validateEntityRefs → resolveEntityFKs →
  packages/factbase/                                                upsertThingsInTx
    data/things/*.yaml
                                                                              ↓
                                                    PG (entities, grants, facts, things, ...)
                                                                              ↓
                                                   build-time: database.json + factbase-data.json
                                                                              ↓
                                                    apps/web reads the JSON, calls /api/* at runtime
```

## Adding functionality — checklist

Before writing new sync/tablebase code:

1. **Grep `deleteBatchHandler`, `validateEntityRefs`, `sqlInList`, `resolveEntityFKs`, `upsertThingsInTx`, `batchSync`** — use what exists.
2. **New `/delete-batch` endpoint**: `deleteBatchHandler(table, "sourceTable")`. Do not hand-write.
3. **New array param query**: `sqlInList()`. Do not write `unnest()` directly.
4. **New sync handler accepting entity refs**: call `validateEntityRefs()` BEFORE upserting.
5. **New route with entity FK columns**: call `resolveEntityFKs()` post-upsert to backfill display names.
6. **New sync orchestrator**: extend `sync-common.ts::batchSync()`. Do not write your own fetch loop.
7. **Run `validate-tablebase-completeness`** before PR — it catches missing sync/delete/validation.

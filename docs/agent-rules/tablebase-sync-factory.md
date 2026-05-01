# TableBase Sync Handler Factory

The `createSyncHandler<T>()` factory in `apps/wiki-server/src/routes/tablebase/sync-factory.ts` is the canonical pattern for TableBase POST /sync routes. As of 2026-04, **28 routes** use the factory (migration from discussion #4088 / issue #4090 is effectively complete except for the 5 permanently-excluded routes below).

## When to use it

**Always use the factory for new sync routes.** Copy an existing factory-using route (e.g., `political-scores.ts` for a simple route, `personnel.ts` for a complex one) and adapt it. Hand-write the Zod schema directly — it's typically 10-15 lines and captures business rules (min/max, enums, regex) that cannot be auto-derived from the Drizzle table definition.

> **Why no scaffolder or schema inference?** A `drizzle-zod` spike (Phase 3, April 2026) showed that auto-derived schemas require ~90 lines of overrides for a 12-line hand-written schema. The override surface is larger than what it replaces. Similarly, a code generator (`crux tb sync-scaffold`) was deleted because it produced TODO-riddled templates that amounted to automated copy-paste. Hand-written Zod schemas are shorter, clearer, and capture business constraints correctly.

## When NOT to use it

5 routes are permanently excluded from the factory (per Phase 0 audit, [issue #4089](https://github.com/quantified-uncertainty/longterm-wiki/issues/4089)):

| Route | Reason |
|-------|--------|
| `entities.ts` | Slug displacement, statement_timeout overrides, relatedEntries validation |
| `things.ts` | IT IS the things table, not a dual-write target |
| `bluesky.ts` | Only `/sync/:did` (external API fetch), no main `/sync` |
| `data-sources.ts` | Multi-table writes per call (resources + tabular sources + snapshots) |
| `ids.ts` | Uses `nextval('entity_id_seq')` for ID allocation, fundamentally different semantics |

If you're adding a route that needs >1 escape hatch (`preValidate`, `postUpsert`, `conflictSet`), the factory is the wrong fit. Hand-roll the route and document why in a comment.

## Scaffolding a new route

Use `pnpm crux tb scaffold <kebab-name>` (QUA-455). It generates the route file, CLI client, crux table-registry entry, and wiki-server mount-registry entry in one shot, with TODO markers for the table-specific bits. See `docs/agent-rules/tablebase-sync-factory.md` — the generator is the canonical way to add a new entity type.

## Hook budget: max 1 per route

The factory provides three escape hatches: `preValidate`, `postUpsert`, `conflictSet`. **Routes should use at most 1.** If you find yourself reaching for a second hook, that's a signal the factory isn't the right fit — hand-roll the route instead.

Representative examples from the 28 factory-using routes:

| Route | Hook | Reason |
|-------|------|--------|
| `personnel.ts` | `postUpsert` | `new:` prefix display-name backfill + things sync refetch (after `fkResolve`) |
| `divisions.ts` | `conflictSet` | COALESCE preservation for nullable fields |
| `political-scores.ts` | (none) | Pure batch upsert with auto-derived SET clause |

## Hook contract

Hooks (`preValidate`, `postUpsert`) receive the Drizzle transaction handle `tx`. They MUST:

1. **Only do DB work via `tx`**. No external HTTP calls, file writes, Discord notifications, or `getDb()` calls for a separate connection.
2. **Throw on failure**. The factory wraps thrown errors in `SyncPhaseError({ route, phase, cause })` and rolls back the transaction. The route returns 500.
3. **Be synchronous within the transaction**. No fire-and-forget patterns.

`preValidate` returns `Response | null`. If a Response is returned, the factory short-circuits and returns it (used for custom 400 errors before the transaction). `postUpsert` returns `void`.

## What the factory handles automatically

- **Parse + Zod validation** — invalid JSON → 400, schema errors → 400
- **Natural key collision** (gated by `naturalKey` config) — intra-batch dedup → 400
- **Source-check enforcement** (gated by `enforceSourceCheck` config) — calls `enforceSourceCheck()` from `source-check-enforcement.ts`
- **Entity FK validation** (gated by `entityRefFields` config) — calls `validateEntityRefs()`
- **Claim validation + linking** (gated by `claimSupport` config) — calls `validateClaimRefs()` pre-tx, `linkClaimsToRecords()` post-tx
- **Batch upsert** — single `INSERT...ON CONFLICT`, auto-chunked based on Postgres parameter limit (`60000 / columnCount`)
- **Auto-derived SET clause** — derived from `toRow()` output keys + `getTableColumns(table)`. Override with `conflictSet`.
- **Audit logging** (gated by `auditRecordType` config) — single batch insert per chunk; existing-row pre-fetch in batch
- **Entity FK resolution** (gated by `fkResolve` config) — calls `resolveEntityFKs()` post-upsert
- **Things dual-write** (gated by `toThing` config) — calls `resolveEntityTitles()` + `upsertThingsInTx()`
- **Inline source-check verdicts** (gated by `toVerdict` config) — calls `writeInlineVerdicts()` in tx
- **Standard response shape** — `{ upserted, verdictsWritten, claimsLinked }`

## What the factory does NOT handle

- **GET /all, /stats, /by-entity** endpoints — hand-roll these. Use the existing `paginatedQuery` helper from `crux/lib/wiki-server/` for pagination.
- **`/delete-batch` endpoints** — use `deleteBatchHandler()` from `apps/wiki-server/src/routes/shared/delete-batch.ts` (factory handles `/sync` only).
- **Slug displacement** — `entities.ts` is excluded from the factory permanently
- **Multiple sync endpoints per route** — only the primary `/sync` is in scope. Secondary endpoints (e.g., `research-areas.ts /sync-papers`) stay hand-rolled.
- **Non-standard primary keys** — the factory assumes `table.id` is the conflict target unless `conflictTarget` is overridden
- **Custom response shapes** — routes that need to return additional fields beyond the standard shape should hand-roll

## Shared helpers for hand-rolled work

For the 5 factory-excluded routes and any hand-rolled GET/DELETE endpoints, these helpers live in `apps/wiki-server/src/routes/shared/`:

| Helper | File | Purpose |
|--------|------|---------|
| `sqlInList()` | `query-helpers.ts` | Parameterized `IN (...)` for array values; wraps `unnest()` correctly |
| `validateEntityRefs()` | `validate-entity-refs.ts` | Batch FK check against `entities.id` and `entities.stable_id`; bypass-with-reason logging |
| `findMissingEntityRefs()` | `validate-entity-refs.ts` | Returns unresolved refs without throwing |
| `shouldSkipEntityValidation()` | `validate-entity-refs.ts` | Migration-mode escape hatch |
| `resolveEntityFKs()` | `resolve-entity-fks.ts` | Post-upsert: resolves raw FK columns (slug/stableId) → `entities.stable_id`, backfills display names |
| `deleteBatchHandler()` | `delete-batch.ts` | Factory for `/delete-batch` endpoints. Deletes from domain table + `things` with FK-safe ordering. Options: `maxBatchSize`, `label`, `pkColumn`, `maxIdLength` |
| `upsertThingsInTx()` | `thing-sync.ts` | Upserts `things` records inside domain transaction |

**Before writing any delete endpoint**: use `deleteBatchHandler()`. Do not write a hand-rolled delete.
**Before writing any array-parameter query**: use `sqlInList()`. Do not write raw `unnest()`.
**Before any hand-rolled sync that takes entity refs**: call `validateEntityRefs()` first.

## Crux-side sync orchestrators

Crux scripts under `crux/wiki-server/sync-*.ts` read YAML source and batch POST to wiki-server. All use `sync-common.ts::batchSync<T>()`, which handles health-check + exponential backoff + consecutive-failure tracking.

**Adding a new sync orchestrator**: extend `batchSync()` from `sync-common.ts`. Do not write your own fetch loop.

## Data flow

```
YAML source           crux/wiki-server/sync-*.ts      apps/wiki-server/src/routes/tablebase/*.ts
  data/entities/   →  batchSync()                 →   createSyncHandler: validate → upsert → resolveEntityFKs → upsertThingsInTx
  packages/factbase/data/fb-entities/
                                                             ↓
                                           PG (entities, grants, facts, things, ...)
                                                             ↓
                                        build-time: database.json + factbase-data.json
                                                             ↓
                                         apps/web reads JSON, calls /api/* at runtime
```

`validate-tablebase-completeness.ts` is the gate check that flags missing `/sync`, `/delete-batch`, and validation calls — run it before PR.

## Testing

The factory is tested in `apps/wiki-server/src/__tests__/sync-factory.test.ts`. The test pattern uses:

- A fake `entities`-shaped Drizzle table (the factory needs SOMETHING to introspect via `getTableColumns()`)
- The existing `mockDbModule` from `test-utils.ts` for transaction + dispatch mocking
- A `buildAppWithErrorCapture()` helper that registers a Hono `onError` handler so tests can assert on `SyncPhaseError` instances

When you migrate a route to the factory, write a new test in `apps/wiki-server/src/__tests__/<route-name>.test.ts` that:

1. Uses `mockDbModule` with a dispatcher that handles your table's queries
2. Tests happy path, FK-invalid, duplicate-id, and any custom hook behavior
3. For routes with `postUpsert` hooks, test that the hook runs and that throwing rolls back

## References

- Discussion: [#4088](https://github.com/quantified-uncertainty/longterm-wiki/discussions/4088)
- Phase 0 audit: [#4089](https://github.com/quantified-uncertainty/longterm-wiki/issues/4089)
- Phase 1 implementation: [#4090](https://github.com/quantified-uncertainty/longterm-wiki/issues/4090)
- Factory source: `apps/wiki-server/src/routes/tablebase/sync-factory.ts`
- Type-level test: `apps/wiki-server/src/routes/tablebase/sync-factory.test-d.ts`
- Mount registry (QUA-454): `apps/wiki-server/src/routes/tablebase/mount-registry.ts`
- Registry cross-check validator (QUA-456): `crux/validate/validate-tablebase-registry.ts`
- Scaffold generator (QUA-455): `pnpm crux tb scaffold <name>` — see `crux/commands/tablebase-scaffold.ts`
- Phase 3 spike results: closed PRs #4099, #4103, #4106, #4108 (v1 migrations archived for reference). drizzle-zod spike showed schema inference is too lossy for this codebase — hand-written schemas are the right choice.

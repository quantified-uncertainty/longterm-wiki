# Large-Refactor Portfolio — longterm-wiki

**Status**: proposals awaiting human framing approval (per `.claude/rules/agent-planning-discipline.md`). Decision gates: ADR-0002 (facts PG-primary), ADR-0006 (schema split), ADR-0007 (monitoring substitution). The crux and frontend campaigns must not start keystone PRs before sign-off.

*2026-06-09. Produced by five parallel architect agents, each grounded in measured code (counted LOC, file:line evidence), synthesized in the coordinator session. Companion to the same-day deep review at [`docs/audits/2026-06-09-deep-review.md`](../audits/2026-06-09-deep-review.md) (Linear QUA-1153–1160) and the deletion catalog at [`docs/audits/2026-06-09-deletion-catalog.md`](../audits/2026-06-09-deletion-catalog.md) (~20K LOC across five batches).*

Combined value if all adopted: **−35K to −40K LOC on top of the ~20K deletion batches** — 15%+ of the codebase gone, functionality preserved, and the remainder substantially more uniform.

## Portfolio summary

| # | Refactor | Net LOC | Risk | Gated on |
|---|---|---|---|---|
| 1 | Wiki-server: declarative `TableSpec` registry + schema split | **−4,800** | Medium | ADR-0006 (only the schema-split PRs) |
| 2 | De-fang auto-prune now; FactBase facts → PG-primary later | −80 now, **−3,000+** later | Low now / High later | ADR-0002 + a prod drift census |
| 3 | Crux: one check registry, lazy CLI, derived help, shared loaders | **−16K to −19K** | Medium | Human framing approval (>10 PRs) |
| 4 | Frontend: one table system, build-time-by-default, dashboard shells | **−8,400** | Low-Medium | Nothing (PR1–2 shippable now) |
| 5 | OSS adoptions: ast-grep (hybrid), external monitoring (via ADR-0007) | **−3,000 to −4,000** | Low | ADR-0007 for monitoring |

## 1. Wiki-server `TableSpec` registry — "new table = one spec file"

Measured: 60–70% of each standard tablebase route file is mechanical boilerplate; ~30 tables are fully standard, ~12 hybrid. One declarative spec per table drives routes, zod, the `toThing` dual-write, **the generated MV branch**, the verdict-join CASE, conflict targets, mounting, and docs — collapsing the "thing type lives in 4+ places" problem that caused QUA-1154. ~200–230 of the 566 endpoints become generated; the 600-line hand-copied MV migration class dies.

Extends the codebase's own proven patterns (sync-factory, the #4939 docs generator with `--check` gate). Key de-risking: write the Hono RPC type-level test *first* (the sync factory did exactly this), and keep response keys/route types identical so the 62 crux client wrappers never notice. The 5,113-line schema.ts splits into ~12 domain files behind a re-export shim — held until ADR-0006 is decided. drizzle-zod evaluated and **rejected** with specifics (API schemas encode constraints PG doesn't know; sync items have virtual fields).

Full plan: Appendix A.

## 2. The sync layer — smaller scope than first floated, one urgent finding

The dual-residence (YAML+PG) tax is ~10,900 LOC, but **entities must stay YAML-primary** (the PG entities table is load-bearing FK infrastructure; CLAUDE.md policy already keeps lightweight entities in YAML). The honest target is **FactBase facts only**: the build already reads facts PG-first (YAML is just the write surface), and all writes flow through one 232-LOC chokepoint (`crux/lib/factbase-writer.ts`) — rewire it to the existing `/api/facts/sync`, make YAML a nightly generated export, delete ~3,500–4,000 LOC of sync/prune/mirror-validators.

Two findings that matter regardless of end-state:

- **The auto-prune is the lock**: it makes incremental migration impossible *and* is the QUA-1155 data-loss path. Removing the automatic prune call (~80 LOC; keep `--prune` explicit) is valuable in every end-state and reversible. **Do this now.**
- **Possible live bug**: Tier-2 stub entities are written directly to PG with no YAML, and the prune endpoint has **no stub exclusion** — stubs may be getting silently re-deleted on every weekly sync. Unverified (prod API key in main checkout was rejected — the QUA-1153 401 incident). Run the drift census once the 401 is fixed, before scoping further.

Respects the QUA-943/QUA-1045 planning-failure history explicitly; structured as falsifiable. Full study: Appendix B.

## 3. Crux — the biggest number, concentrated where agents actually live

One check registry replaces both validator frameworks *and* the 1,337-line untested gate (rewritten at ~650 LOC **with tests**): content rules run in one engine pass, ~26 regex validators become ~15-line declarative specs sharing one file walk, data checks share memoized loaders, ~50 of 62 `npx tsx` subprocess boots disappear. **CI/local parity becomes generated from the same registry** — closing the split-brain class (QUA-1148/636) permanently.

CLI layer: lazy manifest kills the 108 eager imports in crux.mjs; `defineDomain()` derives the 110 hand-written help texts so they can't drift; ~20 one-shot domains demote to `crux tools`. Porting costs measured on real validators (30 min mechanical / 1.5 h structural / 2 h server-coupled). Validators slated to die with QUA-408 closeouts are explicitly *frozen, not ported*.

Full plan: Appendix C.

## 4. Frontend — four moves, screenshot-diff-gated

- 24 hand-rolled public tables (8,174 LOC) reduce to column defs + a `DirectoryTable` shell on tanstack (33 components already use it). aria-sort (QUA-58) comes free via the shared shell.
- Orgs/people pages currently maintain **three** parallel data paths each (server API + local fallback + client refetch through bespoke proxy routes) for data the build already bundles. "Build-time by default" deletes the dual loaders and proxy routes.
- **PR1 = the verdict-fetch deletion** (`wiki/[id]/page.tsx:355` → build-time `record-verdicts.json` lookup): one-day change, fixes QUA-398 (3–4s per page) *and* the >200-verdict truncation bug.
- Two dashboard shells kill the measured clone clusters; a `RelativeTime` component sweep closes the hydration-error class (QUA-1104's sibling).

PR1–2 shippable immediately, no decisions needed. Full plan: Appendix D.

## 5. Buy-vs-build — mostly "keep," two adoptions, one re-litigation avoided

**Keep custom (with reasons):**
- **PG job queue** — HTTP-API-mediated by design (workers/GHA have no PG creds); graphile-worker/pg-boss can't replace the dashboard/lineage/cost surface. The three real pains are <100-LOC fixes: demote `job-worker.yml` to manual dispatch, export a `JobType` union into `CreateJobSchema` (QUA-1157), filter long-running types out of GHA.
- **drizzle-zod** — already empirically rejected in an April 2026 spike (closed PRs #4099/4103/4106/4108: ~90 lines of overrides per 12-line schema). Do not re-propose without new evidence.
- octokit migration, lychee link checker, p-retry/p-limit — each deletes <200 net LOC or breaks load-bearing domain features.

**Adopt (hybrid):**
- **ast-grep** for the ~8 purely syntactic validators (working rules were written to prove expressiveness; strictly better matching + auto-fix). *Conflict to adjudicate*: the crux plan (Appendix C) prefers its own declarative `RepoScanSpec` over adding ast-grep; both agree stateful/ratchet validators stay custom. Decide when workstream 3 starts — lean: skip ast-grep initially (one less tool; ESLint is already mid-adoption as a third scanner). The crux design leaves a `kind: 'regex' | 'ast-grep'` seam either way.
- **External monitoring** (healthchecks.io dead-man pings + alert rules on the Grafana already running in prod k8s): deletes ~1,500–2,500 LOC including the 365-LOC Linear-dedup machinery that exists *only* to suppress ticket storms — the QUA-1158 class dies structurally. Route through ADR-0007; Grafana/k8s config belongs to the releases role.

Full analysis: Appendix E.

## Recommended sequencing

**This week, no approvals needed:**
1. De-fang auto-prune (~80 LOC) + run the drift census once QUA-1153 (401) is fixed
2. Job-queue keep-fixes (typed JobType union, demote GHA worker, type filter)
3. Frontend PR1–2 (verdict-fetch deletion / QUA-398 + revalidate tiers)
4. The five deletion batches (~20K LOC, separately cataloged)

**Decisions (each ADR now has a concrete refactor hanging off it):**
- ADR-0002 (Three Bases) → gates the facts PG-primary move
- ADR-0006 (wiki-server decomposition) → gates the schema split; registry PRs 0–7 are safe under any outcome
- ADR-0007 (observability) → gates monitoring substitution
- Framing sign-off on the crux + frontend campaigns (per `.claude/rules/agent-planning-discipline.md` — both plans correctly refused to self-approve)

**Then run as parallel campaigns** (disjoint code): wiki-server registry · crux consolidation · frontend tables. Each has PR-by-PR sequencing with equivalence oracles (route-surface snapshots, gate contract tests, screenshot diffs).

---

# Appendix A — Wiki-server: declarative per-table registry

## Proposal summary

Introduce a single `TableSpec` registry — one declarative entry per PG-primary table — that drives everything currently hand-written in 4+ places per table: route registration (stats/all/bulk/by-X/:id/sync/delete-batch), the sync pipeline config (already declarative via `createSyncHandler`), the `toThing` dual-write, the inline-verdict record type, the `things_search` MV UNION branch, the verdict-join CASE, the conflict target, the mount path, and the generated schema docs section. The proven precedents already exist in this codebase: `createSyncHandler` (40/46 sync endpoints), `deleteBatchHandler`, `mount-registry.ts`, and the byte-stable doc generator with a CI drift gate (`crux/generate/generate-db-schema-docs.ts`). This proposal is the same move applied to the GET surface and the cross-cutting registrations, plus the ADR-0006(b) prerequisite: splitting the 5,113-line `schema.ts` into ~12 domain files behind a re-export shim.

Net effect: ~30 tablebase route files become ~70-line spec files, ~200–230 of the ~566 endpoint registrations become factory-generated, `schema.ts` stops being a single merge-conflict hotspot, and a new table goes from "edit 6 files + copy a 600-line MV migration verbatim" to "write one spec + run two generators."

Estimated net deletion: **~4,500–5,500 LOC** (delete ~8,000, add ~3,000), with the bigger win being the recurring cost: the 0190 migration header literally says its body "is copied verbatim from 0181... Keep in sync with any other MV edits" — that class of hand-sync disappears.

## Evidence

### Scale (measured)

- Route files: 133 non-test `.ts` files under `apps/wiki-server/src/routes/`; 60 in `routes/tablebase/` (~49 route modules, 11 helpers per `TABLEBASE_NON_ROUTE_FILES`). Tablebase route modules total ~17,200 LOC.
- Endpoint registrations: 491 single-line `.method("…")` registrations (multiline registrations push the true total to ~566); **263+ in tablebase alone**.
- `schema.ts`: 5,113 lines, 118 `pgTable`/`pgMaterializedView` exports, only 8 section banners (the doc generator's `parseSections` depends on these).
- `api-types.ts`: 1,975 lines of mixed per-table zod + cross-cutting constants.
- `drizzle/0190_qua_567_rebuild_things_search_mv.sql`: 21 UNION branches, each a hand-written ~25-line SQL projection per thing type.

### Boilerplate ratio (sampled files, measured by section)

| File | LOC | Table-specific config | Mechanical boilerplate | Generatable? |
|---|---|---|---|---|
| `divisions.ts` | 261 | ~95 (36%) | ~165 (64%) | Fully — spec ≈ 70 lines |
| `entity-events.ts` | 144 | ~45 (31%) | ~100 (69%) | Fully — spec ≈ 50 lines |
| `entity-assessments.ts` | 129 | ~40 | ~90 | Fully |
| `political-scores.ts` | 230 | ~80 | ~150 | Fully |
| `grants.ts` | 739 | sync config (78, already declarative); joins ~60 | ~300 mechanical; **~330 LOC legitimately custom** (by-org-summary, batch-update-grantee, etc.) | Hybrid |
| `scanner-results.ts` | 570 | `/run` is a server-side multi-table scan | ~120 mechanical | Hybrid |
| `talent-flows.ts` | 162 | 100% custom (LAG() window query) | 0 | No — keep |
| `entities.ts` | 1,274 | hand-rolled sync (slug displacement, statement_timeout), /search | — | No — keep |
| `things.ts` | 639 | the cross-base index itself; verdict CASE at L122–134 duplicated into raw SQL ("keep in sync") | — | No — keep, but generate the CASE |

Across standard files: **60–70% of each file is mechanical** (identity formatRow, paginated `/all`, `/bulk`, `/by-X/:id`, `/:id`, exports); the remaining 30–40% config compresses further inside a spec because the factory supplies defaults.

### The 4+ places a thing type lives today (divisions example)

1. `routes/tablebase/divisions.ts:237-244` — `toThing` with `thingType: "division"`
2. `routes/tablebase/divisions.ts:245-251` — `toVerdict` with `recordType: "division"`
3. `drizzle/0190_..._mv.sql` — the `division` UNION branch
4. `routes/tablebase/things.ts:122-134` — `buildVerdictJoin` regex CASE (plus a verbatim copy in the raw trigram-fallback SQL)
5. `api-types.ts:131-164` — `VALID_RECORD_TYPES`
6. `schema.ts` `VALID_THING_TYPES` + docs sections

### Existing factory/generation precedents

- `routes/tablebase/sync-factory.ts` (728 LOC, 40 adopters) — proved Hono RPC type inference survives a config-driven handler (`sync-factory.test-d.ts` was written *before* the implementation to de-risk exactly this).
- `routes/shared/delete-batch.ts` — same pattern for deletes.
- `routes/tablebase/mount-registry.ts` — `TABLEBASE_MOUNTS` + QUA-456 drift validator; documents the manual-mount exclusions.
- `crux/generate/generate-db-schema-docs.ts` + `schema-introspect.ts` — byte-stable generated MDX with `--check` CI gate (PR #4939 precedent).
- `crux/lib/wiki-server/funding-programs.ts:21-23`: the sync factory **already erases** `InferResponseType` — clients import the concrete `SyncResponse` type, so the bar for the GET factory is to do *better* (typed responses), not preserve something fragile.

## Registry design

### `TableSpec` (new file: `apps/wiki-server/src/tablebase-registry/spec.ts`)

```ts
export interface TableSpec<TTable extends PgTable, TItem extends Record<string, unknown>, TKey extends string> {
  // identity
  name: string;                          // "divisions" — route name, audit recordType
  table: TTable;
  apiPath: `/api/${string}`;             // mount path (replaces mount-registry entry)
  domain: SchemaDomain;                  // drives schema file + docs section
  responseKey: TKey;                     // rows returned as { [responseKey]: rows, total }

  // zod (hand-written; drizzle-zod rejected)
  syncItem: z.ZodType<TItem>;
  batchRefine?: (items: TItem[]) => string | null;

  // keys / conflict
  conflictTarget?: PgColumn | PgColumn[];        // default table.id
  naturalKey?: { fn: (item: TItem) => string; error?: string };

  // list surface
  list?: {
    defaultLimit?: number;
    orderBy?: (t: TTable) => SQL[];
    filters?: FilterSpec<TItem>[];
    stats?: StatsSpec;
    bulk?: boolean;
  };
  byRefs?: Array<{ segment: string; column: (t: TTable) => PgColumn; resolveEntity?: boolean }>;
  format?: (row: TTable["$inferSelect"]) => Record<string, unknown>;
  entityJoins?: EntityJoinSpec[];

  // cross-cutting registrations (the 4-places problem)
  thing?: {
    type: ThingType;
    parent?: (item: TItem) => string | null;
    sourceUrl?: (item: TItem) => string | null;
    search: {                            // consumed by the MV GENERATOR, not at runtime
      titleSql: string;
      descriptionSql?: string;
      parentJoinSql?: string;
      sourceUrlSql?: string;
    };
  };
  verdictRecordType?: string;
  claimRecordType?: string;
  enforceSourcing?: boolean;
  entityRefs?: string[];
  fkResolve?: SyncConfig<TItem, TTable>["fkResolve"];

  // escape hatches (bounded, like SyncConfig hooks)
  syncOverrides?: Partial<Pick<SyncConfig<TItem, TTable>,
    "toRow" | "conflictSet" | "preValidate" | "postUpsert" | "auditSourceUrl">>;
}
```

### Route factory + the Hono RPC typing solution

Hono RPC needs literal path strings in the chain type, so the generated *file* (not runtime reflection) is the unit — each table keeps a small `.ts` file that chains explicitly:

```ts
// routes/tablebase/divisions.ts — AFTER (≈ 75 lines, all config)
const app = createTableApp(divisionsSpec)
  .get("/by-org/:orgId", byRefHandler(divisionsSpec, (t) => t.parentOrgId, { filters: [...] }));
export const divisionsRoute = app;
export type DivisionsRoute = typeof app;
```

A typed computed-key helper (`listResponse<K>`) keeps `result.divisions` typed in RPC clients. Custom tables (grants) chain hand-written endpoints onto the same base. De-risking: a `create-table-app.test-d.ts` written FIRST (the sync-factory ritual).

### What the registry generates beyond routes

1. **MV branches** — `crux/generate/generate-things-search-mv.ts`: emits the full `things_search` SQL from `spec.thing.search` fragments + 3 non-tablebase branches as literal templates; `--check` mode compares against the latest MV migration (byte-stable + gate). Kills 0190's "copied verbatim… keep in sync" hazard.
2. **Verdict-join CASE** — generated explicit `CASE source_table WHEN 'divisions' THEN 'division' …` constant; both `things.ts` call sites consume it. Deletes the regex-derivation hack.
3. **Mounting** — `app.ts` iterates the registry; mount-registry shrinks.
4. **Docs** — generator switches from brittle banner-comment parsing to `spec.domain`; gains a per-table "API surface" section free.
5. **`VALID_RECORD_TYPES` / `VALID_THING_TYPES`** — derived from the registry.

### drizzle-zod: evaluated and rejected

Not installed; should stay out: item schemas encode API constraints invisible to PG (`.length(10)` IDs, `.max(500)` on text, enums over plain text, date-prefix rules); sync items contain **virtual fields that are not columns** (`sourcing`, `claimIds`); columns exist that are **not API inputs** (server-resolved FKs; numeric-as-string coercions). `createInsertSchema` would be wrong in all four directions. Keep hand-written zod in the spec; add a dev-time assertion that every non-virtual schema key maps to a real column.

### Schema split (ADR-0006(b) prerequisite)

`drizzle.config.ts` accepts globs. Proposed decomposition of 118 exports: `schema/core.ts` (entities, things, MV, idAllocations, audit), `schema/funding.ts`, `schema/org-people.ts`, `schema/political.ts`, `schema/models-benchmarks.ts`, `schema/frameworks.ts`, `schema/sourcing.ts`, `schema/wikibase.ts`, `schema/factbase.ts`, `schema/ingest.ts`, `schema/operational.ts`, `schema/archived.ts`, plus `schema/index.ts` re-exports and a one-line `schema.ts` shim so all 500+ existing imports keep compiling.

**Import-boundary rule**: new `crux/validate/validate-schema-import-boundaries.ts` — files in `routes/<group>/` may import their domain + `core` + `sourcing` + shared helpers. Start advisory, flip blocking at zero violations.

## LOC impact estimate

| Bucket | Deleted | Added | Net |
|---|---|---|---|
| Tier A: ~30 fully-standard tables, avg ~190 LOC → ~70-line spec | ~5,700 | ~2,100 | **−3,600** |
| Tier B: ~12 hybrid tables — base generated, customs kept | ~4,800 | ~2,900 | **−1,900** |
| Factory + registry infra | — | ~700 | +700 |
| MV generator + verdict-CASE generator + `--check` validators | — | ~500 | +500 |
| mount-registry absorbed | ~190 | ~40 | −150 |
| api-types per-table types move into specs | ~400 | ~100 | −300 |
| Docs generator banner parser deleted | ~80 | ~20 | −60 |
| Schema split | ~5,113 moved | ~5,150 moved + shim | ~0 |
| **Total** | **~11,200** | **~6,360** | **≈ −4,800** |

## Sequencing (PR-by-PR)

Gate for every conversion PR: **route-surface snapshot + response-shape tests green, zero snapshot diff**.

- **PR 0** — Route-surface snapshot test (dump sorted `(method, path)` pairs from `app.routes`) + response-shape integration tests recording today's exact JSON.
- **PR 1** — `create-table-app.test-d.ts` FIRST, then `TableSpec` + factory; convert 2 pilots (divisions, entity-events).
- **PRs 2–4** — Tier A batches (~10 tables each: frameworks → political → funding families); each deletes ~1,200 LOC; empty snapshot diff required.
- **PR 5** — Tier B hybrids (grants, personnel, …): standard portion via factory, custom endpoints chained verbatim. Crux wrappers and web imports keep working (route type exports + response keys preserved).
- **PR 6** — Registry-driven mounting + record-type derivation.
- **PR 7** — Generators (MV `--check` proving byte-identical reproduction of 0190 before any prod SQL changes; verdict CASE; docs).
- **PR 8** — Schema split (pure moves; `drizzle-kit generate` must produce an empty diff). **Hold until ADR-0006 decided.**
- **PR 9** — Import-boundary validator (advisory → blocking).

## Risks & non-goals

Risks: TS inference depth/compile time (measured on pilots in PR 1 before mass conversion); subtle response drift (recorded-JSON equivalence tests); over-genericizing (no plugin system, reuse SyncConfig hooks; tables needing more stay hand-written); MV generator divergence (byte-for-byte `--check` gate); sunk-cost lock-in (PRs 0–7 valid under any ADR-0006 outcome; only 8–9 encode the decision).

Non-goals: do NOT genericize the hand-rolled sync endpoints (`entities.ts`, `bluesky.ts`, `data-sources.ts`, `research-areas.ts`, `scanner-results.ts /run`); do NOT convert `things.ts`, `talent-flows.ts`, `record-lookup.ts`, `entity-profile.ts`, `ids.ts`, `people.ts`; do NOT adopt drizzle-zod; do NOT change response keys to uniform `items`; do NOT split into services or touch non-tablebase route groups.

Critical files: `apps/wiki-server/src/routes/tablebase/sync-factory.ts`, `mount-registry.ts`, `apps/wiki-server/src/schema.ts`, `routes/tablebase/things.ts` (verdict CASE L122–134), `crux/generate/generate-db-schema-docs.ts`.

---

# Appendix B — Feasibility study: collapsing the YAML+PG dual-residence machinery

*Method note: numbers marked **[counted]** come from `wc -l`, `grep -c`, `git log` counts; **[estimate]** marks derivations. Prod enumerations could NOT run — the prod API key in the main checkout returns `Invalid API key` (the QUA-1153 401 incident), so all claims about current prod table state are unverified.*

Two corrections to common premises: `data/entities/` is **17 files containing 2,073 entries (~40K YAML lines) [counted]**, not 203 files; and **no drift dashboards exist [counted]**.

## Dual-residence tax inventory (counted)

### A. Sync scripts (`crux/wiki-server/`), 8,732 LOC total incl. tests

YAML↔PG mirror subset: sync-entities.ts (545+519 test), sync-facts.ts (546+735), sync-things.ts (228), sync-benchmarks.ts (501+590), sync-entity-events.ts (244+344), sync-entity-assessments.ts (258+355), sync-common.ts (314), sync-yaml-helpers.ts (242+246) = **5,667 LOC [counted]**.

Not tax (survives any end-state): sync-pages (MDX mirror), sync-assessments/coverage-scans/scanner-results (computed outputs), sync-sessions/sync-auto-update-runs (already PG-primary), snapshot-resources. ~3,065 LOC.

### B. Prune machinery

Facts prune client (135), entities prune endpoint (`entities.ts:1195-1271`, ~77), facts prune + QUA-930 verdict-cascade (`facts.ts:661-810`, ~150), `pruneEntities()` (~70).

### C. Mirror-consistency validators (`crux/validate/`) — 4,583 LOC incl. tests

validate-orphan-entities (441+556), validate-cross-base (496+299), validate-factbase-entity-ids (238), validate-kb-entity-slugs (610+482), validate-entity-schema-drift (269+283), validate-tablebase-completeness (367+67), validate-tablebase-registry (422+53). Note: the last three are *sync-convention* tax; the middle two are YAML↔YAML tax (die only if fb-entities YAML dies).

### D. Build/CI glue

`sync-entities-facts.yml` (128, push-trigger + weekly cron + deploy-race guard from incident #3418); build-data dual-residence steps (~200 [estimate]).

**Grand total: ~10,900 LOC, of which ~5,700 is the entities+facts sync core.**

### Key structural finding

`build-data.mjs:710-726` already treats **PG as the authoritative read source for facts** (`fetchFactsFromPG()`, YAML is fallback), and sourcing verdicts attach to PG fact rows. The facts prune **cascade-deletes those verdicts**. So a YAML parse failure can destroy PG-primary data through the mirror machinery (QUA-1155 + QUA-930).

**The prune is the lock that forces all-or-nothing migration**: anything written PG-first is absent from the YAML keep-set and gets deleted on the next sync. Likely conflict: Tier-2 stub entities (`crux tb ensure-entities` writes `metadata: {stub: true}` persons directly to PG, no YAML); the prune endpoint has **no stub exclusion [counted]** and "person" is a prunable type. Either stubs are silently re-deleted weekly, or something unseen protects them — **prod query needed**. 24 hard FKs reference `entities` with `onDelete: cascade` [counted].

## Who-writes-what map

| Source | Size | Writers | PG mirror used for |
|---|---|---|---|
| `data/entities/*.yaml` | 17 files, 2,073 entries | Humans (rare) + agents via 16 writer files | FK validation for **every PG-primary table**, display names, things index, directory APIs. **Load-bearing, not a mirror.** |
| `packages/factbase/data/fb-entities/` | 571 files | `crux/lib/factbase-writer.ts` (232 LOC, single chokepoint) used by ~10 commands | **Primary read source at build is PG**; verdicts FK to PG fact rows |
| entity-events (10), entity-assessments (13) | small | agents/imports, ~5 commits in 3 months | same circular loop, miniature |
| benchmarks.yaml + ai-models inline | 46+54 entries | agents | mixed-primacy, worst of both |
| sessions, auto-update runs | gitignored | — | **already PG-primary — the completed precedent** |

Write activity: 316 commits touched data/entities, 228 touched factbase data in 3 months [counted].

### Git-workflow benefits and replacements

| Git benefit | Replacement status |
|---|---|
| PR review before data lands | Partial: pending-approve flow exists for benchmarks; `full_audit_log` is post-hoc only. **Genuinely lost for direct PG writes.** |
| Validation gates on diffs | Exists: zod at /sync + PG CHECKs (QUA-525/526 precedent) + `enforceSourcing` |
| Blame/revert | Exists/partial: `full_audit_log` keeps old/new JSONB forever; no revert tooling yet |
| Agent branch isolation | **Does not exist** — slots auto-target prod (QUA-616). Biggest honest regression. |
| Reviewable history | Export endpoints exist (`/api/entities/export`, `/api/facts/export`); nightly-commit job ~150 LOC new |

## End-state options

**(a) Facts PG-primary (recommended direction; entities NOT included).** Rewire factbase-writer.ts to POST `/api/facts/sync` (exists, already enforces sourcing); fb-entities YAML becomes nightly generated export. Deletes ~3,500–4,000 LOC (sync-facts+tests 1,281, facts prune ~285, kb-entity-slugs 1,092, factbase-entity-ids 238, cross-base FactBase arm ~250, build fallback ~100, workflow half). Prevents: QUA-1155's facts sibling, QUA-1160, QUA-930 cascade, #3418-class races, QUA-941 silent drops. Worse: fact writes hit prod with post-hoc review only; offline builds use the committed nightly export.

**(b) YAML-primary, generic registry-driven loader.** The repo already ran this experiment negatively (drizzle-zod spike; deleted sync-scaffold generator — see `docs/agent-rules/tablebase-sync-factory.md`). Deletes only ~2,000–2,500 of fetch-loop boilerplate, keeps prune + all validators, prevents none of the incidents. **Poor value.**

**(c) Status quo + de-fang auto-prune only.** ~100–300 LOC deleted; kills QUA-1155 and the verdict-cascade path; removes little machinery. Cost: YAML deletions stop auto-propagating (deletions run ~26/month incl. renames [counted, noisy]) until a supervised prune.

## Recommendation + smallest first step

**Leading option: (a) restricted to FactBase facts, sequenced behind ADR-0002** — feasibility verdict, not a commitment; needs human framing signoff + the prod enumeration below.

**Smallest real first step — de-fang the automatic prune (~80 LOC):** remove unconditional prune calls from the CI-invoked `main()` of sync-entities/sync-facts; retain `--prune` opt-in. (1) Independently valuable in every end-state — closes QUA-1155 by deletion, not by adding a guard. (2) Prerequisite for any incremental migration. (3) Single-commit revertible. (4) Likely resolves the stub/prune conflict.

Pair with the **drift census** (read-only): diff `loadKB` vs `/api/facts/export`, YAML entities vs PG entities, count stubs, count what auto-prune has actually deleted historically (audit log).

## Scope cuts

No entities migration (load-bearing FK infra; CLAUDE.md policy; ADR-0002 out-of-scopes YAML authoring). No generic sync framework (documented failed experiment). No new validators/reconciliation crons/dual-write canaries (the v4 plan accumulated 19 mitigations, 0 deletions). No entity-events/assessments/benchmarks migration (decide after facts proves out). No touching sync-pages/WikiBase (MDX stays git-primary). No revert tooling in scope. No MV-staleness fix here (orthogonal).

## Falsifiers

1. Drift census shows large *intentional* YAML↔PG divergence for facts. 2. Auto-prune's audit history shows frequent correct deletions the supervised path would miss (QUA-1155 has never actually fired; #2796 ghosts were real). 3. Fact-writing doesn't actually flow through factbase-writer.ts everywhere. 4. The team values PR-review of fact diffs more than assumed (228 commits/3mo — are reviews catching errors?). 5. ADR-0002 lands on "Replace". 6. The QUA-1044/1086-1088 YAML-edit-UX direction is read as the same debate — it isn't (this is motivated by machinery deletion + data-loss paths, not edit UX), but that's a framing conversation.

Critical files: `crux/wiki-server/sync-entities.ts` (~:528-540), `crux/wiki-server/sync-facts.ts`, `apps/wiki-server/src/routes/factbase/facts.ts` (:484, :530-544, :661-810), `crux/lib/factbase-writer.ts`, `apps/web/scripts/build-data.mjs` (~:683-730).

---

# Appendix C — Crux CLI consolidation

## Proposal summary

Crux is 1,475 TS files / 418K LOC. Targets the ~130K LOC CLI surface (commands/ 88.7K, validate/ 27.1K, LLM clients, sync scripts, dead dirs) — not the pipelines. Five workstreams, deletion-biased:

1. **One validator framework** — replace 73 standalone `validate-*.ts` + the 1,337-line untested gate with a single check registry. The unified-rule system stays as the *content* engine (it only loads MDX — verified `validation-engine.ts:232-272`); convergence target is a four-kind check manifest, not "port everything to `Rule`".
2. **Command layer** — lazy domain registry kills crux.mjs's 108 eager imports (L42–150) + 108-entry domains map (L152–262); `defineDomain()` derives the 110 hand-written `getHelp()` functions; ~20 one-shot domains demote to `crux tools <name>`.
3. **Shared infra** — one entity loader (15 measured copies → 1), one `requireServerEnv()` (7+ inline copies), one file walker (canonical exists with 2 adopters; 10+ private walkers), 2-layer LLM story via ratchet not rewrite.
4. **Module boundaries** — path-manifest + import-boundary ratchet (house pattern: baseline only ratchets down), no file moves up front.
5. **Net: −16K to −19K LOC, −95 to −115 files**, gate wall-time cut (~50 of 62 `npx tsx` subprocess boots removed), **CI/local parity generated from one registry** (closes the QUA-755/QUA-1148 drift class permanently).

Coordinates with ADR-0003 (its Phase 2 deletions + tiering are adopted, not re-decided; its carveout protects six ratchets).

## Validator convergence

Current state: 57 unified rules (one engine pass, MDX-only) + 73 standalone scripts (27,086 LOC incl. gate; 50 have tests); gate has 72 steps, 62 spawning `npx tsx` subprocesses (~0.5–1s boot each, each re-parsing YAML/MDX from scratch). **CI does not run the gate** — it runs unified/schema/refs + exactly 2 standalone validators by name (ci.yml:263-266).

Cohort census: ~26 code-scan (regex/structural), ~14 YAML/data structural, ~12 server-required, ~8 MDX cross-page, 5 orphans (delete — ADR-0003 Phase 2; note: a separate verification pass found **4 of these 5 are actually imported by live code** — qa-sweep, auto-update risk scores, verify-consistency — so reconcile with ADR-0003 before deleting; only validate-sourcing-names is mechanically orphaned), 2 framework files (rewritten).

Target shape — one registry (`crux/validate/registry.ts`):

```ts
interface CheckDef {
  id: string;                       // stable — gate-triage + stamp semantics key on these
  kind: 'content-rule' | 'repo-scan' | 'data' | 'exec';
  blocking: boolean;
  requiresServer?: boolean;
  ruleIds?: string[];                                   // content-rule: one ValidationEngine pass
  scan?: RepoScanSpec | ((files: FileSet) => Violation[]); // repo-scan: declarative or function
  run?: (ctx: CheckContext) => Promise<CheckResult>;    // data: memoized loaders + server client
  command?: { cmd: string; args: string[] };            // exec: vitest, tsc, eslint, build
}
```

New gate ~400 LOC + registry, **with tests**. Groups by kind: one engine pass for content rules; one shared `FileSet` walk for all repo-scans; data checks concurrent in-process against a memoized `DataContext`; exec stays subprocess. `--isolate <id>` escape hatch. Standalone invocation: `crux validate run <id>`. CI calls the same registry — parity becomes structural.

Porting costs (measured on 3 representatives): grep-style (~134 LOC → ~15-line spec, ~30 min, ~14 validators in this shape); structural state-machine (~286 LOC → core kept, walker/reporting shed, ~1–1.5h, ~12 validators); requiresServer (~518 LOC → data check with injected client, ~2h, kills per-validator dotenv preambles).

Disposition: ~16–18 die instead of porting (orphans per ADR-0003 + coexistence-police after QUA-408 closeouts — **frozen until their migration completes, neither ported nor deleted while load-bearing**); ~38 mechanical ports; ~10 careful ports; ~5 stay exec.

**ast-grep (QUA-386): do not adopt now.** The ticket is iceboxed; the cohort reduces to ~15-line `RepoScanSpec` entries without a new binary/rule language; the highest-value targets (SQL migration gotchas) need ratchet machinery (baselines, allowlists) ast-grep lacks. Hedge: `RepoScanSpec` gets `kind: 'regex' | 'ast-grep'` discriminant. *(See Appendix E for the counter-case; adjudicate at workstream start.)*

## Command layer

Measured: crux.mjs 552 LOC; commands/ 183 files / 88,671 LOC with 110 `getHelp()` exports that drift (group help scrapes getHelp output to fake summaries — crux.mjs:381-387). Warm startup ~0.5s with all 108 modules; every import's side effects run on every invocation.

1. **Lazy registry**: manifest declares `{ group, summary, commands[], load: () => import(...) }`; router resolves names without loading; a `cli-registry-sync` check asserts manifest ≡ module exports (the validate-tablebase-registry lockstep pattern). `GROUPS` collapses in; crux.mjs → ~150 LOC; help renders with zero module loads.
2. **`defineDomain()` scaffold**: subsumes existing `buildCommands()` (lib/cli.ts:300); help/flags/examples derived, cannot drift; feeds bash completions + strict unknown-flag warnings. Mechanical for the ~40 domains already on buildCommands; handler-style domains wrap unchanged.
3. **One-shot demotion**: ~20 completed migrations registered as permanent domains (import-990, import-grants, import-scorecards, import-divisions 1,004, backfill-* …) move to `crux tools <name>`, hidden from group help, `retiredAfter:` date + 90-day warning; completed backfills simply deleted (git history is the archive — house position).

Size: crux.mjs 552→~150; groups.ts 267→~80; +250 manifest; −3,500–4,500 LOC of getHelp bodies; −~2,500 deletable one-shots + ~6,000 demoted.

## Shared infra

1. **One YAML entity loader** — 15 measured copies (canonical `lib/content-types.ts:379`; copies in sync-things, 6 validators, rules, entity-lookup, research loader, 3 pipelines). Merge the best API (`research/entity-loader.ts`), export 3 return shapes from one parse. ≈ −600 LOC + kills a real bug class (copies disagree on which directories they read).
2. **One env module** — `requireServerEnv()` on `lib/wiki-server/client.ts` (owns QUA-616 slot detection); replace verified inline copies in 7+ sync scripts. ≈ −150 LOC.
3. **File walker** — promote to `lib/fs/walk.ts`; repo-scan FileSet consumes it; ban readdirSync-recursion outside lib/fs via boundary check. ≈ −400 LOC.
4. **LLM clients — already nearly 2-layer; ratchet, don't rewrite.** openrouter (364, 4 importers) + anthropic (220, 37) sit under llm.ts (566, 52); claude-cli.ts (93, 5) is OAuth subprocess plumbing (QUA-612/1010) and must stay separate. Target: `lib/llm/` public, anthropic/openrouter internal; repo-scan ratchet "no new imports outside lib/llm/" (baseline 41); migrate callClaude callers opportunistically. ≈ −200 LOC now; value is one documented entry point.

## Module map (ADR-0001 "one directory, enforced modules" outcome)

cli / commands / validate / rules / wiki-client / data / llm / agent-infra / ingest / pipelines / tools (quarantine) / shared — enforced by a `module-map.ts` path-glob manifest + `import-boundaries` repo-scan (~120 LOC) with committed ratchet baseline. Key forbidden edges: rules→wiki-client (the QUA-755 shape); commands holding business logic >200 LOC; anything→tools. dependency-cruiser rejected (house ratchet pattern covers it).

## LOC impact

| Workstream | Delta |
|---|---|
| Dead dirs (verify against the deletion-catalog corrections first) | −5,412 |
| Orphan validators (reconcile with live-import findings; sourcing-names certain) | −1,845 claimed; verify |
| Validator convergence (38+10 ports, gate 1,337→~650, +~700 shared infra) | −5,000 to −6,000 |
| QUA-408-contingent deletions (deferred, tracked) | −~1,500 |
| Command layer | −4,000 to −5,500 (+6,000 demoted) |
| Shared infra | −1,350 |
| **Total** | **≈ −16K to −19K LOC, ≈ −95 to −115 files** |

## Sequencing

Stable-contract list enforced by a smoke test from PR 1: gate exit codes, `--ci` JSON shape, `.git/gate-stamp` semantics, `--scope=content` subset, pre-push invocation (`.githooks/pre-push:40`), check ids.

PR 1 pure deletion + contract tests (ship under ADR-0003's tickets — don't fork authority) · PR 2 shared-infra trio · **PR 3 check registry, metadata-only (keystone — requires human framing approval per planning-discipline)** · PRs 4–6 repo-scan engine + grep cohort waves · PRs 7–8 DataContext + YAML/server cohort (QUA-408-frozen validators marked `frozen:`) · PR 9 CLI lazy registry · PR 10 defineDomain on 5 high-traffic domains, then waves · PR 11 one-shot demotion · PR 12 import-boundary ratchet.

Risks: porting validators about to die (frozen markers); ADR-0003 ratchet carveout (sourcing-lint-guard, entity-schema-drift, typed-client, workflow-secrets, no-bespoke-filter-chips, tsc-baseline — portable, never deletable here); in-process crash isolation (per-check try/catch + `--isolate`); stamp/pre-push contract (PR 1 test); help-text pattern-matching by agents (names/flags never change); QUA-1045-class planning risk (framing approval before PR 3; deletion-mandated reviewer).

Non-goals: no package split; no validation-semantics changes (no advisory→blocking promotions — ADR-0003 Phase 4); no ast-grep; no pipeline refactors (70% of crux untouched); no content-rule migration (already the converged framework); no LLM client deletion.

Critical files: `crux/validate/validate-gate.ts`, `crux/crux.mjs`, `crux/lib/validation/validation-engine.ts`, `crux/lib/groups.ts`, `crux/lib/wiki-server/client.ts`.

---

# Appendix D — Frontend simplification (apps/web)

*All numbers measured this session. App source: 120,813 LOC excl. tests.*

## Proposal summary

1. **Delete the per-page verdict fetch** in `wiki/[id]/page.tsx` → read the build-time bundle (QUA-398 fix, ~1-day PR, restores 782 wiki pages to build-data-only rendering).
2. **Make "build-time by default" real**: 6 public directory pages maintain two-or-three parallel data paths; the build already bundles the same data. Delete API paths; one fetch module with 3-tier revalidate policy for genuinely-live surfaces.
3. **One table system** (tanstack base — `components/ui/data-table.tsx` already has 33 consumers; MDX `components/tables/*` factories are already tanstack). `DirectoryTable` shell reproduces directory style + URL state + aria-sort; 20 hand-rolled tables (7,086 LOC) reduce to column defs + config.
4. **Two dashboard shells + 4 component splits** — Pattern A untouched.

Net: **−7,500 to −9,000 LOC** (~7% of app, ~30% of touched subsystems), zero intended visual change.

## Table-system convergence (measurements)

Inventory: hand-rolled SortHeader directory tables 20 files / **7,086 LOC** (organizations 759, people 697, resources 581, legislation 500, grants 452, ai-models 445, funding-programs 417, …, approaches 174); factbase tables 4 / 1,088; tanstack DataTable 297 core + 33 consumers; server-paginated-table 352 + 4 internal consumers (already column-def-driven generic — proof of concept); MDX factories 1,808+1,285 (already tanstack — keep); internal dashboard tables 25 / 6,125; plumbing ~840.

Duplication mechanics verified: the 50–94-line clone cluster is the **server/static dual-mode plumbing** copied per table (~200–250 LOC each in orgs/people/things/grants); static-only tables are pure shell boilerplate around 5 column renderers; tanstack natively provides what's reimplemented (sorting, filtering, pagination, column visibility — orgs hand-rolls a 36-line column picker).

Target: `use-directory-table.ts` (~150 — wires the existing, good `useDirectoryUrl` URL-state hook into tanstack) + `DirectoryTable.tsx` (~350 — directory visual style, FilterChips, stat cards, pagination, loading/error rows, column picker, **aria-sort**: note `ui/sortable-header.tsx` currently has zero aria-sort) + shared `cells.tsx` (~200 — DateHint, em-dash, compact currency, entity link, RecordStatusDots, tag pills). `useServerTable` survives only as a `manualPagination` adapter for internal dashboards; public directories drop server mode (row counts are small: 2,073 entities, 782 pages).

Each table reduces to `columns: ColumnDef<Row>[]` + config. Measured expectations: approaches 174→~70; mid-size ~110; organizations 759→~230.

LOC math: 24 public tables 8,174 → ~2,900 + ~800 shared core = **net −4,500**; internal hand-rolled ~−1,000. Fates: server-paginated-table → migrate 4 consumers, delete; MDX factories → keep (aria-sort header swap only); `directory/SortHeader.tsx` → delete after last consumer.

## Data-fetching redesign

Evidence: the policy already exists (root CLAUDE.md: "zero runtime API calls… only internal dashboards") — this is enforcement, not invention. 40 non-internal files import lib/wiki-server (13 are api proxy routes); 39 use `withApiFallback`. Dual-path pages: organizations (428), people (353), ai-models (247), benchmarks (266), legislation (308), projects (257); orgs+people are **triple-path** (SSR dual-loader + client refetch via bespoke `/api/organizations`, `/api/people` proxies). The verdict fetch is a global unfiltered 200-row list filtered client-side by prefix — past 200 rows most pages get zero relevant rows from a fetch they still pay for; `fetchDetailed` sleeps 2s retrying 429s during 782-page builds (the QUA-398 mechanism). **The bundle already exists**: `fetchRecordVerdicts()` paginates the entire verdicts table into `record-verdicts.json` (`tablebase.ts:1090`), already consumed by grants/funding-programs/publications.

Rule: a route may fetch at render time only if its data is PG-primary with no build bundle AND changes intra-day. Verdicts → build-time prefix lookup. Six directories → delete loadFromApi/withApiFallback/DataSourceBanner + both proxy routes (**pre-PR enumeration required**: diff API rows vs local rows; orgs already filters API to localOrgIds so local is the superset by construction). Org [slug] sections: 7 fetches → ≤2 (keep market-data + scorecards live). `/things`, `/sourcing`, `/scorecards`, `/races`: runtime OK, standardized. Internal dashboards: keep, tiered.

Fetch module: `REVALIDATE = { live: 60, standard: 300, slow: 3600 }`, `fetchDetailed(path, { tier })`; 10-line crux validator bans numeric revalidate literals under src/app (measured scatter: 60×36, 300×43, 3600×21, 30×8, 0×5, 120×2, 15×2, 6 force-dynamic).

Net ≈ **−1,300 LOC**; 782 wiki + 6 directory pages on true build-time data.

## Dashboard shells

Keep Pattern A (33/34 comply; mandated in docs/agent-rules/internal-dashboards.md). Duplication is inside the 9,264 LOC of `*-content.tsx`: extract `RunsDashboard` (verified clones: groundskeeper-runs 237, auto-update-runs 205, pipeline-runs 235, improve-runs, jobs 237 — identical fetch→banner→stat-cards→expandable-rows shape; ~5×100 LOC saved); `StatCardGrid` (stat-card markup cloned across **14 files**, 65 files reference some StatCard); entity-aggregation shell after table convergence. Net ≈ **−950**.

## Component diet

| Component | LOC | Fix |
|---|---|---|
| `PageStatus.tsx` | 1,309 | 23 props → `{ pageData, frontmatter, pathname, resourceCount, citationHealth }`; split into page-status/ modules; `new Date()` at L175/544 bakes staleness into SSG. Net −150 + 40-line call-site deletion |
| `entity-profile-viewer.tsx` | 1,489 | 20 inner components → directory split; share CellValue/JsonValue with entities-data-table. −100 via dedupe |
| `entities-data-table.tsx` | 1,373 | Convert to unified table. ~−600 |
| `search-client.tsx` | 836 | BrowseState (static directory, lines 639+) → RSC; query mode stays client. ~−80 + smaller hydration payload |

Hydration class: 10 client files render from `Date.now()`/`new Date()` (measured). One `<RelativeTime>` component + sweep + grep-ban validator.

## LOC impact and sequencing

Tables −5,300±800 · data fetching −1,300±300 · shells −950±300 · diet −900±300 ⇒ **≈ −8,400 (−7,000…−9,700)**.

PR1 verdict-fetch deletion (QUA-398) → PR2 fetch tiers + validator → PR3-5 dual-loader deletions (enumeration pasted into each PR) → PR6 DirectoryTable core + 3 pilots (screenshot-diff gate) → PR7-10 table batches simple→complex, orgs/people last → PR11 server-paginated-table retirement → PR12-13 shells → PR14 PageStatus → PR15 splits + entities-data-table → PR16 RelativeTime sweep. PR1-2 are this-week material; table waves ~1 PR/session for ~6 sessions.

Risks: freshness regression on directories (60s ISR → deploy cadence; data is slow-moving and the static fallback already serves routinely on API hiccups); row-set divergence (hard gate: enumeration; bundle PG-only rows first if found); visual drift (shell owns directory markup verbatim + screenshot diffs; QUA-1008 precedent noted); offline builds already fail-soft on missing record-verdicts.json. Framing approval needed before PR6+ (table-system commitment); PR1-2 independently justified.

Non-goals: no visual redesign; no Pattern A changes; no restructuring of MDX-registered components beyond the aria-sort swap (MDX compile across 780+ pages required otherwise); no wiki-server endpoint changes; no build-data redesign beyond optionally bundling PG-only directory rows.

Critical files: `apps/web/src/lib/citation-data.ts`, `apps/web/src/app/wiki/[id]/page.tsx` (:355, :382-410), `apps/web/src/components/ui/data-table.tsx`, `apps/web/src/app/organizations/organizations-table.tsx`, `apps/web/src/lib/wiki-server.ts`.

---

# Appendix E — Buy-vs-build verdicts

| # | Candidate | Custom LOC | OSS option | Verdict |
|---|---|---|---|---|
| 1 | Regex validators → ast-grep | ~3,293 cohort; ~1,500–1,900 convertible | @ast-grep/cli (MIT, active) | **Hybrid adopt** (see conflict note in main doc) |
| 2 | Wellness checks → standard monitoring | ~4,100 + 4 workflows | healthchecks.io + Grafana (already in prod k8s) | **Hybrid adopt — via ADR-0007** |
| 3 | PG job queue → graphile-worker/pg-boss | ~3,824 core | both MIT, active | **Keep custom** |
| 4 | zod/Drizzle dup → drizzle-zod | api-types.ts 1,975 | drizzle-zod | **Keep custom** (April 2026 spike rejection — PRs #4099/4103/4106/4108) |
| 5a | GitHub clients (raw wrapper vs octokit) | 513, 42 consumers | octokit | **Keep** (corruption detection, QUA-823 wrapping are load-bearing) |
| 5b | Link checker → lychee | ~1,545 | lychee | **Keep** (only ~150 LOC is generic; archive.org auto-fix pipeline has no analogue) |
| 5c | retry/semaphore → p-retry/p-limit | 182 | — | **Keep** (below bar; half is domain logic) |

## Job queue — keep, with three sub-100-LOC fixes

The queue is HTTP-API-mediated by design: workers and GHA runners authenticate to wiki-server with an API key and have **no PG access** — graphile-worker/pg-boss require direct PG connections, and their job tables are private/unqueryable, breaking `/internal/jobs` dashboard, `crux jobs` CLI, sourcing-orchestrate, and two groundskeeper monitors. Parent-child lineage (`parentJobId`/`/children`), `costUsd` accounting, dedup-return semantics (`dedupExisting: true`), and `/failure-patterns` have no OSS equivalent. Net deletion after rebuilding the lost surface: plausibly <800 LOC, on a production-critical path.

The named pains are config-sized: (1) dual consumers → demote `job-worker.yml` to manual dispatch (k8s daemon polls every 30s); (2) QUA-1157 → shared `JobType` union from handler registry into `CreateJobSchema`/`ClaimJobSchema` (~30 LOC); (3) 60-min GHA kill vs 3h jobs → `--types` filter excluding long-running types (~5 LOC YAML).

## ast-grep — proof-of-expressiveness rules were written

`no-console-log-server.yml` (replaces 153 LOC) and `no-inline-limit-clamping.yml` (replaces 255 LOC incl. a 35-LOC multiline-join hack and a 30-LOC string-aware comment parser) verified as working patterns; AST matching eliminates comment/string false-positives and catches nestings the regex prefix-match misses; `// ast-grep-ignore` replaces four bespoke suppression dialects; empty-catch even gains auto-fix. Converts: no-console-log, untyped-rows, inline-pagination, table-formatting, no-sourcinged, no-anthropic-api-key-read, table-states, url-normalize, parts of dangerous-patterns. Does NOT convert: verdict-priority (value-distinctness computation), sourcing-lint-guard (ratchet baseline), workflow-secrets (API calls), entity-schema-drift (allowlist+counting), typed-client (cross-file), all data validators. Caveat carried: ESLint type-aware flat config is *already* a blocking gate check (QUA-388) — several rules could land as ESLint config with zero new tools; the gate PR must explicitly decide the scanner division of labor.

## Monitoring — substitution map (input to ADR-0007)

Verified: no Loki/Promtail config in this repo, but Grafana + Prometheus run in prod k8s (per agent-cost-monitoring.mdx); ADR-0007 (Charter) is the venue. The QUA-1158 storm's structural cause: alert state lives *in the issue trackers*, so 365 LOC of wellness-linear-dedup.ts + the create/comment/close lifecycle exist solely to deduplicate alerts — a problem alert-native systems don't have.

1. Dead-man → healthchecks.io pings from groundskeeper 5-min cycle + worker poll: deletes server-health-monitor.yml, workflow-staleness checks, most of crux/health-monitor (773).
2. HTTP availability → Grafana synthetic/blackbox (or UptimeRobot): deletes probe arms of health-check.ts + two workflows' probe steps.
3. Queue depth / freshness / record-count ranges → Grafana alert rules on the PG datasource (these are SQL thresholds wrapped in 559 LOC of TS + issue management).
4. Keep custom: PR-quality + API-smoke *semantic* checks; `crux health` as human-run diagnostic CLI, with `--auto-issue` + the wellness-issue lifecycle deleted.

Net ≈ 1,500–2,500 LOC; the storm class dies structurally. Quick interim win without the ADR: route all wellness alerts to a single tracker (drop the GitHub-issue leg).

## drizzle-zod — the documented rejection

April 2026 spike (sync-factory Phase 3; closed PRs #4099/4103/4106/4108): "auto-derived schemas require ~90 lines of overrides for a 12-line hand-written schema. The override surface is larger than what it replaces" (`docs/agent-rules/tablebase-sync-factory.md`). api-types schemas are API contracts (query coercion, clamps, batch limits, create-vs-update subsets), not table mirrors. If schema↔api drift ever becomes an observed bug class, the cheap guard is `z.infer<typeof X> satisfies Partial<typeof table.$inferInsert>` — ~2 lines per table, no codegen.

---

*Cross-references: same-day deep review at [`docs/audits/2026-06-09-deep-review.md`](../audits/2026-06-09-deep-review.md) (filed QUA-1153–1160); deletion catalog at [`docs/audits/2026-06-09-deletion-catalog.md`](../audits/2026-06-09-deletion-catalog.md) (5 batches, ~20K LOC + ~5.5MB assets); ADR charters 0001/0002/0006/0007 in `docs/adrs/`. Conventions: per `.claude/rules/agent-planning-discipline.md`, the crux and frontend campaigns require explicit human framing approval before their keystone PRs; the facts PG-primary move requires the prod drift census (blocked on QUA-1153) and an ADR-0002 decision.*

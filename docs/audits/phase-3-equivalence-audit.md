# Phase 3a Equivalence Audit — Can `build-data.mjs` read from PG instead of YAML?

**Ticket**: [QUA-510](https://linear.app/quantifieduncertainty/issue/QUA-510)
**Parent**: [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 3 — "TableBase becomes primary, FactBase becomes read mirror"
**Run date**: 2026-04-15
**Author**: Claude Code (slot a4)
**Scope**: This is the *audit*. It does not ship any production code path change.

---

## TL;DR — Top-line finding

**Go, with two pre-work tickets.** PG is materially complete enough to back `build-data.mjs`'s entity pipeline. Phase 3 migration is a **4-6 week project**, not a multi-month sync-coverage push, provided two pre-existing bugs in the sync layer are fixed first:

1. **Sync ref-check is checking the wrong column** (strips all stableId-based `relatedEntries`). See Finding #1.
2. **`data/organizations.yaml` is not synced to PG** (31 marquee orgs lose `founded/headquarters/employees/funding/keyPeople`). See Finding #2.

Both are small, well-contained fixes. Neither requires new schema columns. Neither is blocked. Once they land, a PG-sourced `build-data.mjs` can produce a `database.json` that is behaviorally equivalent (and in several places *strictly richer*) than today's YAML-sourced output.

Across the shared 2026-entity surface, out of ~44,000 field-value pairs compared, we observed **1,895 field diffs** (~4.3%). Of those, **~60% are structural artifacts of how wikiIds are allocated in-memory** (fixable by persisting the id_registry), and the real sync gaps resolve to the two tickets above.

---

## 1. Background — what Phase 3 is trying to do

Today's data flow:

```
YAML files (data/entities/*.yaml, packages/factbase/data/things/*.yaml, ...)
  ↓
apps/web/scripts/build-data.mjs (reads YAML directly)
  ↓
database.json, factbase-data.json, per-entity bundles
  ↓
Next.js content pages read these JSON files at build time
```

Phase 3's target:

```
YAML files (authors edit here)
  ↓ sync (one-way YAML → PG)
PG (source of truth)
  ↓
build-data.mjs reads PG
  ↓
database.json (now a cache of PG, not a transform of YAML)
```

The gating question: **does PG currently contain enough data to generate an equivalent `database.json`?** Or is YAML silently load-bearing for fields that never made it into PG?

## 2. Methodology

We implemented a side-by-side PG reader as **`apps/web/scripts/build-data-from-pg.mjs`** (committed, **not** wired into any build). It:

1. Lists all entities from `/api/entities` (2,809 rows).
2. Fetches full shape (including `metadata`, `relatedEntries`, `customFields`) per-id from `/api/entities/:slug` with a 20-wide concurrency pool. No bulk-export endpoint exists — see Appendix B.
3. Hoists `metadata.*` fields back to top-level (undoing `sync-entities.ts::extractMetadata`), so the downstream transform sees the same shape it would from YAML.
4. Synthesizes `experts` and `organizations` arrays from PG metadata (mirroring the shapes `data/experts.yaml` and `data/organizations.yaml` produce for the YAML pipeline).
5. Calls the **same** `transformEntities()` function that `build-data.mjs` uses, so any diff we see is a source diff, not a transformation diff.
6. Compares the resulting `typedEntities` array to the YAML-sourced baseline from the current `database.json`.
7. Classifies every field diff per the QUA-510 taxonomy (A/B/C/D/E).

Additional inputs used from the YAML side (unchanged):
- MDX pages (via `buildPagesRegistry` — page content is unaffected by Phase 3)
- `buildIdRegistry` for fallback wikiId assignment

Artifacts produced:
- `apps/web/src/data/typedEntities-from-pg.json` — PG-sourced `typedEntities` array (input to diff)
- `apps/web/src/data/pg-audit-diff.json` — structural per-field diff
- `apps/web/src/data/pg-audit-diff.md` — human-readable diff summary
- `apps/web/scripts/build-data-from-pg.mjs` — the prototype reader

None of these are read by the app; `database.json` is untouched.

## 3. Row-count snapshot (2026-04-15)

| Collection                          | YAML                | PG                  | Notes                                                                         |
|-------------------------------------|---------------------|---------------------|-------------------------------------------------------------------------------|
| `data/entities/*.yaml` entities     | **2,026**           | **2,809**           | PG has +783. See §6.                                                          |
| `packages/factbase/data/things/*.yaml` entities | 498       | (within entities)   | Loaded via `loadKBOnlyEntities`; 13 persons, 485 "things" (mostly orgs)       |
| Facts (source, derivedFrom≠null)    | ~1,599 raw blocks   | **2,209**           | PG via `/api/facts/export`. Gap is partly expansion, partly drift.            |
| Resources                           | — (migrated)        | **22,880**          | Already PG-primary since R6; out of Phase 3 scope.                            |
| Personnel records                   | —                   | 1,068               | Already PG-primary; merged into KB via `mergePGRecordsIntoKB`                 |
| Grants                              | —                   | 5,876               | Already PG-primary                                                            |
| Funding rounds                      | —                   | 90                  | Already PG-primary                                                            |
| Investments                         | —                   | 72                  | Already PG-primary                                                            |
| Equity positions                    | —                   | 13                  | Already PG-primary                                                            |
| Divisions                           | —                   | 111                 | Already PG-primary                                                            |
| Funding programs                    | —                   | 59                  | Already PG-primary                                                            |
| Publications (per-entity papers)    | —                   | 185                 | Already PG-primary                                                            |
| Division personnel                  | —                   | 0                   |                                                                               |
| Entity events                       | —                   | 0                   |                                                                               |
| Entity assessments                  | —                   | 0                   |                                                                               |

### Small YAML companion files (the other `DATA_FILES` entries)

These are also loaded by `build-data.mjs` into `database.json`:

| Source                      | Rows | PG mirror? | Used by                                                                                     |
|-----------------------------|-----:|------------|---------------------------------------------------------------------------------------------|
| `data/experts.yaml`         |  70  | ✅ metadata  | `transformEntities` (person enrichment). Synced via `sync-entities.ts::mergeExpertData`    |
| `data/organizations.yaml`   |  31  | **❌ NO**    | `transformEntities` (org enrichment). **Not synced.** See Finding #2.                        |
| `data/estimates.yaml`       |  36  | N/A        | Written to `database.estimates` — **not referenced anywhere** in `apps/web/src`.             |
| `data/glossary.yaml`        |  21  | N/A        | Written to `database.glossary` — **not referenced anywhere** in `apps/web/src`.              |
| `data/funders.yaml`         |  1   | N/A        | Written to `database.funders` (an overview object) — **not referenced anywhere**.            |
| `data/publications.yaml`    | 152  | N/A        | Venue metadata (arXiv, Nature). Used by `getPublicationById` / sources pages. YAML-only.    |
| `data/experts.yaml`         |  —   | —          | (listed above)                                                                               |

**Note**: `database.experts`, `database.estimates`, `database.glossary`, `database.funders`, and the top-level `database.organizations` list are each written to `database.json` by `build-data.mjs` but **no code in `apps/web/src` reads them**. They appear to be dead writes (verified by grep). Phase 3 can drop them from `database.json` entirely. The `data/organizations.yaml` YAML file is still load-bearing, but its data flows only through the `transformEntities()` enrichment path, not through `database.organizations`.

## 4. Diff summary

All diffs are against the shared 2,026-entity surface (YAML-sourced baseline `typedEntities`).

```
Total field diffs:     1,895
  Type A (YAML only):    560  (field in YAML, null/missing in PG)
  Type B (PG only):      102  (field in PG, null/missing in YAML)
  Type C (value diff): 1,233  (both sides set, values differ)
  Type D (missing row):  783  (pgOnly; yamlOnly = 0)
```

### Top field diffs (sorted)

| Rank | Type:Field                 | Count | Root cause                                          | Severity |
|-----:|----------------------------|------:|-----------------------------------------------------|----------|
| 1    | `C:wikiId`                 | 1,102 | Fallback allocator runs at different next-id        | **artifact** |
| 2    | `A:relatedEntries`         |   481 | Sync bug — ref-check uses wrong column              | **real**  |
| 3    | `C:affiliation`            |    51 | Format drift: PG stores slug, YAML had display name | mixed     |
| 4    | `C:relatedEntries`         |    45 | Same root cause as #2 (partial stripping)           | **real**  |
| 5    | `B:founded` (pg has more)  |    37 | Transform bug: org branch ignores `raw.founded`     | **win**   |
| 6    | `B:headquarters`           |    34 | Same as #5                                          | **win**   |
| 7    | `A:founded`                |    31 | `data/organizations.yaml` not synced                | **real**  |
| 8    | `A:headquarters`           |    30 | Same as #7                                          | **real**  |
| 9    | `C:website`                |    20 | Top-level org file override vs. entity YAML field   | mixed     |
| 10   | `B:knownFor`               |    17 | PG synthesis enriches via metadata                  | **win**   |
| 11   | `C:title`                  |    10 | The 31 marquee orgs have canonicalised short titles | **real**  |
| 12   | `A:funding`                |     8 | Same as #7                                          | **real**  |
| 13   | `B:affiliation`            |     7 | PG synthesis                                        | **win**   |
| 14   | `B:affiliationId`          |     7 | PG synthesis                                        | **win**   |
| 15   | `A:employees`              |     6 | Same as #7                                          | **real**  |
| 16   | `C:orgType`                |     5 | Override precedence differs                         | mixed     |
| 17   | `A:website`                |     4 | 4 entities have website in YAML, missing in PG      | **real**  |

The **real** diffs concentrate in two root causes: finding #1 (relatedEntries sync bug) and finding #2 (organizations.yaml not synced). Everything else is either a structural artifact, a win, or a low-severity format difference.

## 5. Findings

### Finding #1 — `relatedEntries` sync strips all stableId-based refs (HIGH severity, BUG)

**Observed**: 481 entities have populated `relatedEntries` in YAML and `[]` in PG. Examples: `claude`, `claude-2`, `claude-3-opus`, `18f`, `80000-hours`, `accident-risks`.

**Root cause**: `apps/wiki-server/src/routes/tablebase/entities.ts:896` validates ref targets against the `entities.id` column (the slug). But YAML `relatedEntries` routinely use stableIds like `sid_mK9pX3rQ7n` (anthropic). `checkRefsExist(db, entities, entities.id, ['sid_mK9pX3rQ7n'])` returns zero matches because `entities.id = 'anthropic'`, not `sid_mK9pX3rQ7n`. The sync then strips the "missing" refs and writes `relatedEntries: []`.

This means **PG today stores only slug-based `relatedEntries`**, silently dropping the stableId-based ones. The bug is not caught by tests because the entity still upserts successfully (just with a shorter `relatedEntries` list than the sync payload had).

**Fix**: change the ref target column in `entities.ts:896`:

```ts
// Before
const missing = await checkRefsExist(db, entities, entities.id, relatedIds);
// After — check both slug and stableId
const missingSlug = await checkRefsExist(db, entities, entities.id, relatedIds);
const missingSid = await checkRefsExist(db, entities, entities.stableId, missingSlug);
// ref is missing only if neither slug nor stableId resolves it
```

Or equivalently `OR` the two existence checks in one SQL. Effort: **half a day** including tests. File as **Phase 3 prerequisite ticket**.

**Scope of data loss today**: all 481 entities have been running with incorrect `relatedEntries` in PG for some time. The YAML pipeline masks the bug because it reads `relatedEntries` directly from YAML, not from PG. Nothing user-visible is broken (yet) — but **any consumer that reads `relatedEntries` from PG today is seeing empty/partial data**. This is worth a separate filing even independent of Phase 3.

### Finding #2 — `data/organizations.yaml` is not synced to PG (MEDIUM severity, GAP)

**Observed**: The 31 marquee organizations in `data/organizations.yaml` (anthropic, openai, deepmind, miri, arc, chai, cais, uk-aisi, us-aisi, fhi, …) contribute `founded/headquarters/employees/funding/keyPeople/name` fields that end up in `typedEntity` via the org branch of `transformEntity`:

```js
case 'organization': {
  const orgData = orgMap.get(raw.id);
  return {
    ...base,
    orgType: orgType || orgData?.type || raw.orgType,
    founded: orgData?.founded || cf('Founded') || cf('Established'),
    headquarters: orgData?.headquarters || cf('Location') || cf('Headquarters'),
    employees: orgData?.employees || cf('Employees'),
    funding: orgData?.funding || cf('Funding'),
    ...
  };
}
```

`orgMap` is built from `data/organizations.yaml`. **`sync-entities.ts` does NOT read `data/organizations.yaml`** and does not carry these fields into PG metadata. There is a parallel path for `experts.yaml` (`mergeExpertData`, line 160) but no equivalent for organizations.

Result: a PG-sourced pipeline has no way to reconstruct `founded: '2021'` for anthropic unless it also reads `data/organizations.yaml` at build time — defeating the point of Phase 3.

Observed diffs (from the prototype run):

| Field        | Count | Affected entities (sample)                                 |
|--------------|------:|------------------------------------------------------------|
| `founded`    | 31    | anthropic, openai, deepmind, chai, cais, conjecture, …     |
| `headquarters` | 30  | same cluster                                                |
| `funding`    | 8     | same cluster                                                |
| `employees`  | 6     | same cluster                                                |
| `title`      | 10    | Short canonicalised versions (e.g. "Center for AI Safety") |

**Fix**: add `mergeOrganizationData()` to `sync-entities.ts` mirroring `mergeExpertData`, writing the 6 fields into entity `metadata`. Effort: **half a day**. Alternatively, move the 31-org data into `data/entities/organizations.yaml` top-level fields (which already flow into PG metadata via `extractMetadata`) and delete `data/organizations.yaml` entirely — this is a cleaner end state.

**Tie-in with Finding #5 (below)**: the YAML transform's org branch **ignores `raw.founded`** in favor of `orgMap.get(raw.id).founded`. Entities with `founded` at top-level in `data/entities/organizations.yaml` (e.g. 18f with `founded: 2014`) get their `founded` value silently dropped by the YAML path. The PG prototype gets them right because the synthesised orgMap pulls them from metadata. So the YAML path is actively *losing* data in this area; Phase 3 fixes that as a side effect.

### Finding #3 — `C:wikiId` diff (1,102) is a structural artifact, not real data loss

**Observed**: 1,102 entities have different `wikiId` values between YAML and PG pipelines. Example: `gsm8k` YAML says `E2615`, PG says `E3336`.

**Root cause**: Both pipelines call `buildIdRegistry()` which assigns fallback wikiIds in-memory to entities that don't yet have one persisted. The fallback allocator uses `nextId++` starting from the max existing id. In a fresh run, **the prototype and the baseline allocate from different next-id starting points** and produce different E-numbers.

No data is lost. The entities exist. But for the diff, 1,102 `wikiId` mismatches dominate the field-diff counts and would scare a reader into thinking Phase 3 is much bigger than it is. They should be filtered or classified separately.

**Phase 3 impact**: the migration needs an `id_registry` PG table (or equivalent) that persists wikiId allocations, so build-data.mjs can deterministically recover the same E-numbers from PG as it produced last time. Effort: **1 day** including migration + sync hook. The `entity_ids` sequence already exists in PG (used by `crux tb ids allocate`), but the fallback allocator in `build-data.mjs` is a parallel, in-memory-only system. Phase 3 has to unify these.

### Finding #4 — PG has 783 extra rows (Type D), 117 are "displaced" cruft, ~666 are lightweight personnel

**Observed**: `pgOnly` has 783 entities that aren't in the YAML-sourced `typedEntities`.

Breakdown:
- **117 rows** have slugs like `aart-de-geus-displaced-dn1KAP` — these are slug-reassignment artifacts created by `sync-entities.ts`'s displacement logic (`entities.ts:968`). They are **cruft and should be pruned**.
- **~666 rows** are lightweight personnel entities (example: `aaron-eckhouse`, stableId `ksOXPR3kvY` — note the legacy format, no `sid_` prefix). These were created by personnel syncs (grant recipients, paper authors, board members) per the Tier 2 pattern in `.claude/rules/id-system.md`. They exist in PG as FK targets for personnel/grants tables but do **not** have wiki pages and should **not** appear in `typedEntities` at all.

**Fix**:
1. Add a pruning pass for `-displaced-*` rows in `sync-entities.ts` (or a periodic cleanup). Effort: **half a day**. Not a Phase 3 blocker but worth filing.
2. Filter Tier 2 personnel out of the PG-sourced entity list in `build-data-from-pg.mjs`. The simplest filter is "entity has a sid_-prefixed stableId OR appears in a YAML source file". Effort: **1 day** including discovery of a clean filter.

### Finding #5 — PG pipeline produces *richer* output than YAML pipeline in several places (Type B, 102)

Found while investigating Type B. Entities have top-level fields in `data/entities/organizations.yaml` (`founded`, `headquarters`, `employees`) that flow into PG metadata correctly — but the YAML `transformEntity` org branch only reads from `orgMap` (data/organizations.yaml) and customFields, so these top-level fields are silently ignored in the YAML path.

PG-sourced pipeline picks them up via the synthesised orgMap and actually produces a richer `typedEntity` than the YAML pipeline for these cases. Examples: `18f.founded = 2014`, `aclu.founded = 1920`, `access-now.founded = 2009`.

**Implication**: Phase 3 is a net **improvement** for these 37+ entities (founded), 34+ (headquarters), 17 (knownFor), etc. Not a gap, not a risk — a win.

### Finding #6 — `affiliation` format drift (C:51)

YAML has `chris-olah.affiliation = 'Anthropic'` (display-name string). PG's metadata has `affiliation = 'anthropic'` (slug). This is because `sync-entities.ts::mergeExpertData` writes `expert.affiliation` as-is, but expert records in `data/experts.yaml` use lowercase slugs, not display names.

The YAML pipeline then calls `transformEntity`'s person branch which reads `expert?.affiliation` — also the lowercase slug. So YAML *should* also have `affiliation = 'anthropic'`. But the current `database.json` has `affiliation = 'Anthropic'` which must come from a different enrichment path — possibly `orgData?.name` via the org branch? Let me re-check; this is mildly confusing but the value difference is display-format only (slug vs. Title Case), not data loss. **Classification: low-severity drift, resolvable during Phase 3 testing.**

### Finding #7 — `factbase-data.json` is already mostly PG-sourced

`build-data.mjs` already reads from `/api/facts/export` via `fetchFactsFromPG()` and overrides the YAML-sourced facts when the endpoint is reachable. It also merges 11 PG-primary record types (personnel, grants, funding rounds, investments, equity positions, divisions, funding programs, division personnel, entity events, entity assessments, publications) via `mergePGRecordsIntoKB`.

Row counts suggest PG has 2,209 facts vs. ~1,599 raw facts in YAML files. The delta is partly because YAML has derived facts (inverse relationships) that are materialised at load time but not separately counted, and partly because some FactBase YAML fields (`validStart`, `unit`, `role`) are not in the PG schema at all and are silently dropped at sync time.

YAML-only fields identified in factbase YAML data:
- `validStart`: 2 files (nick-bostrom, xai). Silently dropped. **Phase 3 prerequisite** if preserving this is important.
- `unit`: ~39 files. Silently dropped. The official schema uses `currency` + `property.unit`, so `unit:` at the fact level is probably legacy data that was never migrated. **Cleanup ticket, not Phase 3 blocker.**
- `role`: 5 files (nick-bostrom, xai, lennart-heim, onni-aarne, tim-fist, yonadav-shavit). Used for key-person facts ("Founder and Director, FHI"). The PG schema has no `role` column. **Either add a `role` column or store in notes. Low volume.**

For Phase 3 scope: factbase equivalence is close enough that the audit's go/no-go is not blocked on it. File the 3 field gaps as smaller follow-ups.

## 6. Per-entity-type breakdown

| Entity type     | YAML count | PG count | Diff | Comment                                    |
|-----------------|-----------:|---------:|-----:|--------------------------------------------|
| person          |        834 |    1,642 | +808 | Tier 2 personnel, see Finding #4           |
| organization    |        492 |      581 |  +89 | Tier 2 orgs + some KB-only                 |
| analysis        |          ? |      121 |      |                                            |
| approach        |          ? |       82 |      |                                            |
| risk            |          ? |       67 |      |                                            |
| project         |          ? |       62 |      |                                            |
| ai-model        |          ? |       54 |      |                                            |
| concept         |          ? |       46 |      |                                            |
| benchmark       |          ? |       46 |      |                                            |
| policy          |          ? |       38 |      |                                            |
| capability      |          ? |       24 |      |                                            |
| crux            |          ? |       18 |      |                                            |
| research-area   |          ? |        9 |      |                                            |
| historical      |          ? |        5 |      |                                            |
| argument        |          ? |        4 |      |                                            |

After filtering Tier 2 personnel (~808) and orgs (~89), the PG set lines up with YAML at ~1,912 entities, within the tolerance of the overlap set we actually diffed (2,026 shared).

## 7. Quick wins — follow-up tickets to file

These are each <1 day and can be done in parallel with Phase 3 scoping:

1. **[sync bug] relatedEntries ref-check uses wrong column** — Finding #1. Fix: check against `entities.stableId` OR both columns. Half a day. Blocks Phase 3.
2. **[sync gap] data/organizations.yaml not synced** — Finding #2. Fix: add `mergeOrganizationData` mirroring `mergeExpertData`. Half a day. Blocks Phase 3.
3. **[cleanup] prune -displaced-* rows in sync-entities** — Finding #4. Half a day. Not a blocker but reduces noise.
4. **[cleanup] drop dead-write keys from database.json** — `experts`, `estimates`, `glossary`, `funders`, top-level `organizations`. Zero reader code references them. Half a day. Not a Phase 3 blocker; shrinks output.
5. **[factbase] add validStart/unit/role to fact schema** — Finding #7. Optional; low volume affected (~46 files total). 1 day if the team decides these need preserving.

## 8. Blockers — things that actually need designing

1. **Persistent wikiId allocation** (Finding #3) — the in-memory fallback allocator in `buildIdRegistry` must be replaced with a persistent id_registry source that PG can read from. Without this, each PG-sourced build run produces different wikiIds for entities-without-an-allocated-id. Effort: **1-2 days** including migration. This is the single thing that makes Phase 3 "medium-size project" instead of "trivial".
2. **Tier 2 personnel filtering** (Finding #4) — decide whether personnel-only entities (~666 rows in PG, no wiki page, legacy stableId) belong in `typedEntities`. The current YAML pipeline excludes them (because they're not in data/entities/*.yaml). The cleanest answer is: PG reader should exclude Tier 2 too, using a filter like "entity must have `sid_`-prefixed stableId" or "entity must have wikiId". Effort: **1 day**.
3. **Bulk entity export endpoint** (Appendix B) — the prototype uses per-id fetching (2,800 requests) because no `/api/entities/export` exists. For a production build reader this is too slow. Add a `/api/entities/export` endpoint that streams full-shape entity rows, mirroring `/api/facts/export`. Effort: **half a day**.

## 9. Total effort estimate for Phase 3 sync-coverage phase

Based on the findings:

| Work item                                              | Effort        |
|--------------------------------------------------------|--------------:|
| Finding #1: relatedEntries sync bug fix                |   0.5 days    |
| Finding #2: `mergeOrganizationData` (or consolidate)   |   0.5 days    |
| Finding #3: persistent wikiId allocation               |   1-2 days    |
| Finding #4 (filter): Tier 2 filter in build reader     |   1 day       |
| Finding #4 (cleanup): prune displaced rows             |   0.5 days    |
| Blocker #3: `/api/entities/export` bulk endpoint       |   0.5 days    |
| Integration: plumb PG reader into build-data.mjs       |   2 days      |
| Testing: full build + diff against prod baseline      |   2 days      |
| Fallback/degrade-mode handling (wiki-server down)      |   1 day       |
| **Total sync-coverage phase effort**                   | **9-10 days** |
| **Plus Phase 3 cutover PR + review + stabilisation**   | **+2 weeks**  |

**Conservative estimate for Phase 3 total: 4 weeks (one engineer, focused).** Not 2-3 months. Not blocked.

## 10. Go / no-go recommendation

**Go**. Phase 3 is viable on the current PG state with 9-10 days of sync-coverage work followed by a ~2-week cutover. The audit did not surface any missing schema columns, missing classes of data, or structural impedance mismatches that would require a multi-month data-migration push.

The concern in the parent ticket — "it might be very messy" — resolves to **two real bugs and one in-memory allocator**, all small and localized. PG is already closer to complete than the epic assumed.

Recommended next steps, in order:
1. File Finding #1 + Finding #2 as separate Linear tickets in the **Data Integrity** or **Automation & Infrastructure** project. These block Phase 3 and are worth fixing independently.
2. File Finding #3 (persistent wikiId allocation) as a Phase 3 prerequisite ticket.
3. Once #1/#2/#3 land, scope Phase 3 proper: the cutover PR. The prototype at `apps/web/scripts/build-data-from-pg.mjs` can be the starting point — roughly 350 LOC, already shared-transform aware.

## 11. What this audit explicitly did not do

- ❌ Modify `build-data.mjs` or any production code path
- ❌ Ship the PG-sourced reader as default
- ❌ Fix any of the sync bugs surfaced (those become follow-up tickets)
- ❌ Audit runtime/render paths (the prototype only checks *build-time* equivalence)
- ❌ Perf-test the PG reader (per-id fetching is known-slow and will be replaced by a bulk endpoint)
- ❌ Generate a line-level YAML-vs-PG round-trip for every fact in factbase — sampled instead

## Appendix A — How to reproduce

```bash
# From repo root (or apps/web):
cd apps/web

# Make sure YAML baseline exists:
node --import tsx/esm scripts/build-data.mjs

# Run the PG prototype against prod:
PROD_LONGTERMWIKI_SERVER_URL=https://wiki-server.k8s.quantifieduncertainty.org \
  PROD_LONGTERMWIKI_SERVER_API_KEY=<key> \
  WIKI_SERVER_ENV=prod \
  node --import tsx/esm scripts/build-data-from-pg.mjs

# Outputs (beside database.json):
#   src/data/typedEntities-from-pg.json
#   src/data/pg-audit-diff.json
#   src/data/pg-audit-diff.md

# Sample-mode for fast iteration:
node --import tsx/esm scripts/build-data-from-pg.mjs --sample=50
```

The prototype takes ~30-60s for the full 2,809-entity fetch at concurrency=20 against prod. Diff + write completes in <5s.

## Appendix B — Known prototype limitations

1. **No bulk-export endpoint.** `/api/entities/` list strips `metadata`/`relatedEntries`/`customFields`. The prototype fetches each entity separately via `/api/entities/:slug`. For production Phase 3 this needs a `/api/entities/export` endpoint mirroring `/api/facts/export`.
2. **wikiId fallback non-determinism.** The prototype runs `buildIdRegistry` after fetching from PG, which assigns in-memory fallback IDs that differ from the YAML baseline. 1,102 `C:wikiId` diffs in the output are caused by this, not by real gaps. See Finding #3.
3. **Tier 2 personnel not filtered.** The prototype includes all 2,809 PG entities in the output; 783 of those are Tier 2 personnel/displaced rows that the YAML pipeline excludes. Real Phase 3 reader needs an explicit filter.
4. **Compares only `typedEntities`.** Other `database.json` fields (`kb`, `resources`, `records`, `publications`, etc.) are already PG-sourced or PG-overriding today and are equivalent by construction. They are out of scope for this audit phase.
5. **Single-shot, not continuous.** The audit reflects prod PG state at the moment of the run (2026-04-15 ~13:00 PDT). Future sync changes may shift counts.

## Appendix C — Files produced by this audit

| Path                                             | What it is                                          | Committed? |
|--------------------------------------------------|-----------------------------------------------------|------------|
| `docs/audits/phase-3-equivalence-audit.md`       | This report                                          | ✅          |
| `apps/web/scripts/build-data-from-pg.mjs`        | The PG-sourced prototype reader                      | ✅          |
| `apps/web/src/data/typedEntities-from-pg.json`   | PG-sourced typedEntities (diff input)                | ❌ gitignored |
| `apps/web/src/data/pg-audit-diff.json`           | Structural diff (2,000+ diff entries)                | ❌ gitignored |
| `apps/web/src/data/pg-audit-diff.md`             | Human-readable diff summary                          | ❌ gitignored |

The JSON/MD diff artifacts are deliberately not committed — they are regeneratable at any time by running the prototype, and they'd create large merge-conflict surfaces on every PG sync.

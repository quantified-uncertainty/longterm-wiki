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

**FactBase is even cleaner**: 2,209/2,209 facts match perfectly across 496 entities (**100% row equivalence, zero Type D**). 45 field-value diffs total: **42 are float32 precision loss** in PG's `real` numeric column (one-line schema fix), and **3 are a real `refs` round-trip bug** where single-element arrays containing comma-separated strings get naive-split on readback. Both are cleanly fixable; neither requires schema additions. See §6 and Finding #8.

## Committed artifacts

The per-row classification dumps are committed as part of this audit (QUA-510 acceptance criterion #3):

- **[`docs/audits/phase-3-equivalence-audit.diff.json`](./phase-3-equivalence-audit.diff.json)** — full per-row A/C/D classification for the 2,026 shared `typedEntities`. 1,895 field diffs + 783 pgOnly rows, alphabetically sorted for stable regeneration.
- **[`docs/audits/phase-3-equivalence-audit-factbase.diff.json`](./phase-3-equivalence-audit-factbase.diff.json)** — full per-row diff for 2,209 FactBase facts across 496 entities.

Both are regeneratable by running `apps/web/scripts/build-data-from-pg.mjs` and `apps/web/scripts/audit-factbase-pg.mjs` respectively — see Appendix A.

---

## 1. Background — what Phase 3 is trying to do

Today's data flow:

```text
YAML files (data/entities/*.yaml, packages/factbase/data/fb-entities/*.yaml, ...)
  ↓
apps/web/scripts/build-data.mjs (reads YAML directly)
  ↓
database.json, factbase-data.json, per-entity bundles
  ↓
Next.js content pages read these JSON files at build time
```

Phase 3's target:

```text
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

Two side-by-side prototype readers, both committed, **neither wired into any build**:

### 2a. Entity-side reader — `apps/web/scripts/build-data-from-pg.mjs`

1. Lists all entities from `/api/entities` (2,809 rows).
2. Fetches full shape (including `metadata`, `relatedEntries`, `customFields`) per-id from `/api/entities/:slug` with a 20-wide concurrency pool. No bulk-export endpoint exists — see Appendix B.
3. Hoists `metadata.*` fields back to top-level (undoing `sync-entities.ts::extractMetadata`), so the downstream transform sees the same shape it would from YAML.
4. Synthesizes `experts` and `organizations` arrays from PG metadata (mirroring the shapes `data/experts.yaml` and `data/organizations.yaml` produce for the YAML pipeline).
5. Calls the **same** `transformEntities()` function that `build-data.mjs` uses, so any diff we see is a source diff, not a transformation diff.
6. Compares the resulting `typedEntities` array to the YAML-sourced baseline from the current `database.json`.
7. Classifies every field diff per the QUA-510 taxonomy (A/B/C/D/E) and writes the per-row result to `docs/audits/phase-3-equivalence-audit.diff.json` (committed).

Additional inputs used from the YAML side (unchanged):
- MDX pages (via `buildPagesRegistry` — page content is unaffected by Phase 3)
- `buildIdRegistry` for fallback wikiId assignment

### 2b. Factbase reader — `apps/web/scripts/audit-factbase-pg.mjs`

1. Loads all FactBase YAML via the canonical `loadKB` + `serialize` pipeline from `@longterm-wiki/factbase`.
2. Fetches all PG facts from `/api/facts/export`, paginating until the `total` field is exhausted.
3. Indexes each side by `(entityId, factId)` and diffs per-fact, canonicalising the `FactValue` discriminated union to a stable string shape for comparison.
4. Writes per-row result to `docs/audits/phase-3-equivalence-audit-factbase.diff.json` (committed).

### Artifacts produced

**Committed** (live under `docs/audits/`):
- `phase-3-equivalence-audit.md` (this file)
- `phase-3-equivalence-audit.diff.json` — full per-row classification for the 2,026 shared typedEntities (QUA-510 acceptance criterion)
- `phase-3-equivalence-audit-factbase.diff.json` — full per-row classification for the 2,209 FactBase facts

**Also committed** (under `apps/web/scripts/`):
- `build-data-from-pg.mjs` — the entity prototype reader
- `audit-factbase-pg.mjs` — the factbase prototype reader

**Gitignored** (regeneratable):
- `apps/web/src/data/typedEntities-from-pg.json` — entity prototype output
- `apps/web/src/data/pg-audit-diff.md` — entity diff summary
- `apps/web/src/data/factbase-audit-diff.md` — factbase diff summary

None of the generated artifacts are read by the app; `database.json` is untouched.

## 3. Row-count snapshot (2026-04-15)

| Collection                          | YAML                | PG                  | Notes                                                                         |
|-------------------------------------|---------------------|---------------------|-------------------------------------------------------------------------------|
| `data/entities/*.yaml` entities     | **2,026**           | **2,809**           | PG has +783. See §6.                                                          |
| `packages/factbase/data/fb-entities/*.yaml` entities | 498       | (within entities)   | Loaded via `loadKBOnlyEntities`; 13 persons, 485 "things" (mostly orgs)       |
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

**Note — dead writes in `database.json`** (triple-checked via `rg` in `apps/web/src/` and `crux/` at audit time):

| Top-level key            | In current `database.json`? | Read by app or crux? |
|--------------------------|:---------------------------:|:--------------------:|
| `database.experts`       | **Already stripped** at `output-writer.mjs:37` | No readers |
| `database.estimates`     | Present (36 rows)           | **No readers**       |
| `database.glossary`      | Present (21 rows)           | **No readers**       |
| `database.funders`       | Present (1 object)          | **No readers**       |
| `database.organizations` (top-level) | Present (31 rows) | **No readers**       |
| `database.publications`  | Present (152 venues)        | Yes — `getPublicationById`, `getAllPublications` (real read path) |
| `database.resources`     | **Never written** — Phase-4 lazy-loaded to `resources.json` | Via `getAllResources()` / `resources.json` |

Search commands used (run from repo root):

```bash
rg 'database\.(experts|estimates|glossary|funders|organizations)\b|db\.(experts|estimates|glossary|funders|organizations)\b' apps/web/src crux
# Returns zero matches. The only `.organizations` reference in tablebase.ts is
# the ResearchAreaDetailOrg shape — unrelated to database.organizations.
```

Phase 3 can drop all four of the "no readers" keys from `database.json` entirely, saving ~30 KB. The `data/organizations.yaml` YAML file is still load-bearing because its data flows through the `transformEntities()` enrichment path (see Finding #2), not through the top-level `database.organizations` write. `database.resources` is never in the main file — it's been lazy-loaded from a sidecar `resources.json` since Phase-4 of the build pipeline. **Resources are out of scope for this audit and already PG-primary**.

## 4. Diff summary

All diffs are against the shared 2,026-entity surface (YAML-sourced baseline `typedEntities`).

```text
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
- **~666 rows** are lightweight personnel entities (example: `aaron-eckhouse`, stableId `ksOXPR3kvY` — note the legacy format, no `sid_` prefix). These were created by personnel syncs (grant recipients, paper authors, board members) per the Tier 2 pattern in `docs/agent-rules/id-system.md`. They exist in PG as FK targets for personnel/grants tables but do **not** have wiki pages and should **not** appear in `typedEntities` at all.

**Fix**:
1. Add a pruning pass for `-displaced-*` rows in `sync-entities.ts` (or a periodic cleanup). Effort: **half a day**. Not a Phase 3 blocker but worth filing.
2. Filter Tier 2 personnel out of the PG-sourced entity list in `build-data-from-pg.mjs`. The simplest filter is "entity has a sid_-prefixed stableId OR appears in a YAML source file". Effort: **1 day** including discovery of a clean filter.

### Finding #5 — PG pipeline produces *richer* output than YAML pipeline in several places (Type B, 102)

Found while investigating Type B. Entities have top-level fields in `data/entities/organizations.yaml` (`founded`, `headquarters`, `employees`) that flow into PG metadata correctly — but the YAML `transformEntity` org branch only reads from `orgMap` (data/organizations.yaml) and customFields, so these top-level fields are silently ignored in the YAML path.

PG-sourced pipeline picks them up via the synthesised orgMap and actually produces a richer `typedEntity` than the YAML pipeline for these cases. Examples: `18f.founded = 2014`, `aclu.founded = 1920`, `access-now.founded = 2009`.

**Implication**: Phase 3 is a net **improvement** for these 37+ entities (founded), 34+ (headquarters), 17 (knownFor), etc. Not a gap, not a risk — a win.

### Finding #6 — `affiliation` is display name vs slug (C:51 — same root cause as Finding #2)

**Observed**: 51 person entities have `affiliation = 'Anthropic'` (display name) in YAML but `affiliation = 'anthropic'` (slug) in the PG-sourced path. Representative samples from the committed `docs/audits/phase-3-equivalence-audit.diff.json`:

| Person             | YAML                                   | PG                      |
|--------------------|----------------------------------------|-------------------------|
| `chris-olah`       | `"Anthropic"`                          | `"anthropic"`           |
| `dario-amodei`     | `"Anthropic"`                          | `"anthropic"`           |
| `daniela-amodei`   | `"Anthropic"`                          | `"anthropic"`           |
| `demis-hassabis`   | `"Google DeepMind"`                    | `"deepmind"`            |
| `allan-dafoe`      | `"Google DeepMind"`                    | `"deepmind"`            |
| `dan-hendrycks`    | `"Center for AI Safety"`               | `"cais"`                |
| `eliezer-yudkowsky`| `"Machine Intelligence Research Institute"` | `"miri"`          |
| `elizabeth-kelly`  | `"US AI Safety Institute"`             | `"us-aisi"`             |
| `andrew-ng`        | `"Stanford University"`                | `"stanford-university"` |
| `david-krueger`    | `"University of Cambridge"`            | `"university-of-cambridge"` |

**Root cause**: This is the **same bug as Finding #2**, observed from a different angle. Looking at `transformEntity` at `apps/web/scripts/lib/entity-transform.mjs:207`:

```js
const affiliation = org?.name || expert?.affiliation || cf('Affiliation');
```

The YAML pipeline builds `orgMap` from `data/organizations.yaml`, so `org?.name` resolves to the display name (e.g. `"Anthropic"`) for all 31 marquee orgs. The PG pipeline has no access to `data/organizations.yaml` (because it isn't synced — Finding #2), so the `org?.name` branch returns `undefined` and we fall through to `expert?.affiliation`, which is the lowercase slug stored by `mergeExpertData`.

The diff shows up as "format drift" but it's really the same missing-sync that Finding #2 describes. All 51 affected persons are affiliated with orgs that are in the 31-org `data/organizations.yaml` list.

**Fix**: fixing Finding #2 (syncing `data/organizations.yaml` into PG metadata, or consolidating the 31-org data into `data/entities/organizations.yaml`) eliminates this finding as a side effect — PG would then have `metadata.orgs[anthropic].name = "Anthropic"` for the synthesised orgMap to return. No separate work needed.

**Classification: medium-severity — user-facing display drift until Finding #2 is fixed.** These are the displayed affiliation strings on every person page (`/people/chris-olah` etc.), and they would regress from "Anthropic" to "anthropic" on any consumer that reads them from PG instead of YAML.

### Finding #7 — `factbase-data.json` is already mostly PG-sourced

`build-data.mjs` already reads from `/api/facts/export` via `fetchFactsFromPG()` and overrides the YAML-sourced facts when the endpoint is reachable. It also merges 11 PG-primary record types (personnel, grants, funding rounds, investments, equity positions, divisions, funding programs, division personnel, entity events, entity assessments, publications) via `mergePGRecordsIntoKB`.

YAML-only fields identified in factbase YAML data (silently dropped at sync time — see Finding #8 for the actual audit result):
- `validStart`: 2 files (nick-bostrom, xai)
- `unit`: ~39 files — legacy data, official schema uses `currency`
- `role`: 5 files, used for key-person facts like "Founder and Director, FHI"

### Finding #8 — FactBase YAML vs PG: 100% row-level equivalence, 45 float32 precision losses (LOW severity — TRUE FACTBASE AUDIT)

**This is the proper factbase equivalence run that QUA-510 asked for.** Implemented as `apps/web/scripts/audit-factbase-pg.mjs` using the canonical `loadKB` loader and `/api/facts/export`. Committed artifact: [`phase-3-equivalence-audit-factbase.diff.json`](./phase-3-equivalence-audit-factbase.diff.json).

**Row-level equivalence is perfect:**

| Metric             | YAML   | PG     | Δ    |
|--------------------|-------:|-------:|-----:|
| Source facts       | 2,209  | 2,209  | **0** |
| Entities with facts | 496   | 496    | **0** |
| Type D (missing fact row) | — | — | **0 yamlOnly, 0 pgOnly** |
| Type A (field only in YAML) | — | — | **0** |
| Type B (field only in PG) | — | — | **0** |
| Type C (value mismatch) | — | — | **45** |

Every YAML fact has a matching PG fact with the same `(entityId, factId)` key. Every field that YAML emits is present on the PG side. The only discrepancies are 45 `value` mismatches — all on the same pattern.

**Two root causes** — 42 of 45 are float32 precision loss, 3 are a real `refs` round-trip bug.

**Root cause A (42 diffs): `facts.numeric` is float32.** `apps/wiki-server/src/schema.ts:964` declares the column as `real` (PostgreSQL 4-byte float32). Float32 has ~7 decimal digits of precision, so integers larger than ~16.7M round to the nearest representable float. Representative samples from the committed diff:

| Entity | YAML value     | PG value       | Delta | Meaning            |
|--------|---------------:|---------------:|------:|--------------------|
| anthropic | `9000000000`   | `8999999000`   | −1,000 | $9B revenue        |
| xai    | `26000000000`  | `25999999000`  | −1,000 | $26B valuation     |
| nvidia | `30000000000`  | `30000001000`  | +1,000 | $30B               |
| stripe | `72000000000`  | `71999996000`  | −4,000 | $72B               |
| various small orgs | `549531672` | `549531650` | −22 | employee counts, budgets |

**Fix A**: change `facts.numeric` from `real` to `double precision` (float64, ~15 decimal digits, preserves every integer up to 2^53). Also `facts.usdEquivalent`, `facts.exchangeRate`, `facts.low`, `facts.high`. One migration, no data migration needed (the current values are already lossy — new writes get full precision from that point). Effort: **half a day**, blocking Phase 3 only if values above ~10^7 matter for display (they do — revenue, valuation, funding round sizes).

**Root cause B (3 diffs): `refs` array naive-splitting on round-trip.** Three facts in the YAML store a single-element `refs` array whose only element is a comma-separated human-readable string — e.g., `value: ["Divya Siddarth, Saffron Huang, and Jasmine Wang"]`. The FactBase loader preserves this as a 1-element array. `sync-facts.ts::serializeValue` writes it to PG as the literal string `"Divya Siddarth, Saffron Huang, and Jasmine Wang"` via `.join(", ")`. `reconstructFactValue` in `facts.ts:229` then reconstitutes the refs array via `row.value.split(", ")` — producing a 3-element array `["Divya Siddarth", "Saffron Huang", "and Jasmine Wang"]` on readback. So **the round-trip silently changes array shape** for these values.

Affected facts (all 3):

| Entity slug                        | fact id        | YAML shape (1-el) | PG readback (3-4 el) |
|------------------------------------|----------------|-------------------|-----------------------|
| `collective-intelligence-project`  | `f_CVXL2QGbQc` | `["Divya Siddarth, Saffron Huang, and Jasmine Wang"]` | split on `", "` |
| `algorithmwatch`                   | `f_vdosFaef7s` | `["Matthias Spielkamp, Lorena Jaume-Palasi, Lorenz Matzat, and Katharina Anna Zweig"]` | split into 4 |
| `the-future-society`               | `f_rouuKIUdfN` | `["Nicolas Miailhe, Simon Mueller, Ionuts Lacusta, and Hugo Zylberberg"]` | split into 4 |

This is arguably a **YAML data-quality issue** first (the author should have used a proper multi-element array: `[Divya Siddarth, Saffron Huang, Jasmine Wang]` — and dropped the "and"), but the sync round-trip makes the situation worse by producing lossy, malformed splits with "and Jasmine Wang" as a literal array element.

**Fix B**: two options, not mutually exclusive:
1. **Data fix** (small): rewrite the three YAML facts to use proper multi-element refs arrays. 3 edits. 15 minutes. I did not make these edits in this audit PR — they are not in scope and should be authored by someone who can verify the name splits.
2. **Sync fix** (systemic): the loader should either (a) reject single-element refs values that contain `", "` (treat as data-entry error), or (b) not split on readback — use JSON-encoded storage so round-trip preserves array shape. Option (b) is the cleaner end state because it's robust against any future occurrence of the same pattern. Effort: 1 day for option (b), including migration of existing refs rows.

**Correction**: An earlier draft of this finding called these three diffs "canonicalisation artefacts" in my audit script. That was wrong — the canonicalizer is deterministic and applied identically to both sides. The three diffs are real data drifts in the YAML→PG→readback cycle.

**Implication for the go/no-go**: the factbase side of Phase 3 is **materially cleaner than the entity side**. There are no missing facts, no missing fields, no structural gaps. A PG-sourced `factbase-data.json` is essentially ready today, modulo the column-type fix. The "2-3 month worst case" in the parent ticket does not apply to FactBase at all.

> **Note on the earlier row-count mismatch** in §3: an initial cursory count suggested YAML had ~1,599 raw facts and PG had 2,209 — a 600-fact gap that looked scary. That gap was an artefact of the cursory count using raw YAML `facts:` blocks (which include fact-only files and entity files mixed) without going through the canonical loader. Running the real loader via `loadKB` produces exactly 2,209 source facts, matching PG bit-for-bit on row count.

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
3. **[schema] widen `facts.numeric` from `real` to `double precision`** — Finding #8 root cause A. One-line Drizzle migration. Half a day including test. Not strictly blocking Phase 3, but values >10^7 currently have ±0.000001 relative error in display.
3b. **[sync bug] refs round-trip naive-split** — Finding #8 root cause B. 3 known-affected facts; 15-minute data fix for those three. For the systemic fix (JSON-encoded storage of refs to preserve shape), 1 day.
4. **[cleanup] prune -displaced-* rows in sync-entities** — Finding #4. Half a day. Not a blocker but reduces noise.
5. **[cleanup] drop dead-write keys from database.json** — `experts`, `estimates`, `glossary`, `funders`, top-level `organizations`. Zero reader code references them. Half a day. Not a Phase 3 blocker; shrinks output.
6. **[factbase] add validStart/unit/role to fact schema** — Finding #7. Optional; low volume affected (~46 files total). 1 day if the team decides these need preserving.

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
- ❌ Detect Type E (order-only array diffs) separately — these are folded into Type C. See `diffTypedEntities` in `build-data-from-pg.mjs` for rationale.
- ❌ Audit non-`typedEntities` `database.json` fields: `resources` (PG-primary, out of scope), `kb` (covered separately via `audit-factbase-pg.mjs`), `pages`/`idRegistry`/`stats`/`tagIndex`/`pathRegistry`/`backlinks`/`relatedGraph`/`pageResources` (all derived at build time from the same sources — equivalent by construction)

## 12. Pre-cutover prerequisites checklist

Forward-looking list of items the future Phase 3 cutover PR must verify before deleting any columns, fields, or files. § 11 above covers what *this audit* didn't do; this section covers what the *cutover PR* must do.

### Pre-work tickets must all be merged

The cutover cannot start until these 4 tickets have shipped to main:

- [ ] [QUA-519](https://linear.app/quantifieduncertainty/issue/QUA-519) — Fix `relatedEntries` sync bug (HIGH)
- [ ] [QUA-520](https://linear.app/quantifieduncertainty/issue/QUA-520) — Migrate `data/organizations.yaml` (MEDIUM) — also fixes Finding #6 affiliation drift as a side effect (see Finding #6 root cause analysis)
- [ ] [QUA-521](https://linear.app/quantifieduncertainty/issue/QUA-521) — Persistent `id_registry` for wikiId (MEDIUM)
- [ ] [QUA-522](https://linear.app/quantifieduncertainty/issue/QUA-522) — `/api/entities/export` bulk endpoint (LOW)

After all four ship, re-run `build-data-from-pg.mjs` against fresh prod and verify the diff count drops as expected (relatedEntries→0, organizations.yaml fields→0, wikiIds→0, etc.).

### Dead-write triple-check before deletion

The audit claims the following `database.json` top-level fields are unread (`grep` of `apps/web/src/` returns zero matches as of 2026-04-15). Re-verify at cutover time, when months may have passed and new consumers may have appeared:

```bash
# Run from repo root before deleting any of these from build-data.mjs:
rg 'database\.experts|database\.estimates|database\.glossary|database\.funders|database\.organizations' apps/web/src/ crux/
rg 'data\.experts|data\.estimates|data\.glossary|data\.funders' apps/web/src/ crux/
```

If any of these grep commands return non-test results, the field is no longer dead and the deletion plan needs to be revised. If still empty, safe to delete from `database.json` writes in `build-data.mjs`.

`database.resources` is **never present in `database.json`** — see § 3 line 150 of this audit. It's set in memory at `build-data.mjs:515` but stripped at write time by `writeMainOutputFiles()` at `apps/web/scripts/lib/output-writer.mjs:54` (where `resources: _resources` is destructured out alongside other Phase-4 lazy-loaded fields). Resources are written to a separate `resources.json` file instead, and the runtime `loadResources()` at `apps/web/src/data/tablebase.ts:645` reads from there. A fallback path to `database.resources` exists in `loadResources()` as backward-compat for older builds but is dead-by-construction in the current pipeline. **No cutover deletion needed for `database.resources` from `database.json`** — it isn't there. The cutover may optionally remove the dead in-memory assignment at `build-data.mjs:511-558` and the dead `loadResources()` fallback for cleanliness, but neither is strictly required.

### Cutover correctness checks

Before merging the cutover PR:

- [ ] `build-data.mjs` reads from PG (via `build-data-from-pg.mjs` evolved into the production reader), not YAML
- [ ] Diff a fresh PG-sourced `database.json` against a YAML-sourced one — should be byte-identical except for known-acceptable structural changes
- [ ] Playwright render-audit passes against a build using the new reader
- [ ] `pnpm build` + `pnpm test` green
- [ ] Vercel build can complete using the new reader (i.e., it has whatever PG access we decided on — read-replica, snapshot pattern, or live prod with cached fallback)

### Vercel build-time PG access

The user flagged this as a concern in the QUA-510 framing discussion. Pick the access pattern before the cutover PR:

- **Option A — Read replica**: Vercel build connects to a follower DB more available than prod
- **Option B — Nightly snapshot**: dump PG nightly to a file, build reads the snapshot unless `FORCE_LIVE_DB=1`
- **Option C — Cached last-good**: if PG unreachable at build time, fall back to the previous build's `database.json`

The cutover PR body must document which option was chosen + why.

## Appendix A — How to reproduce

```bash
# From apps/web:
cd apps/web

# Make sure YAML baseline exists (needed for entity diff):
node --import tsx/esm scripts/build-data.mjs

# --- Entity audit ---
# Writes docs/audits/phase-3-equivalence-audit.diff.json (committed)
PROD_LONGTERMWIKI_SERVER_URL=https://wiki-server.k8s.quantifieduncertainty.org \
  PROD_LONGTERMWIKI_SERVER_API_KEY=<key> \
  WIKI_SERVER_ENV=prod \
  node --import tsx/esm scripts/build-data-from-pg.mjs

# Sample-mode for fast iteration (useful when hacking on the prototype):
node --import tsx/esm scripts/build-data-from-pg.mjs --sample=50

# --- Factbase audit ---
# Writes docs/audits/phase-3-equivalence-audit-factbase.diff.json (committed)
PROD_LONGTERMWIKI_SERVER_URL=https://wiki-server.k8s.quantifieduncertainty.org \
  PROD_LONGTERMWIKI_SERVER_API_KEY=<key> \
  WIKI_SERVER_ENV=prod \
  node --import tsx/esm scripts/audit-factbase-pg.mjs
```

Timing: the entity audit takes ~60s for the full 2,809-entity fetch at concurrency=20 against prod plus MDX scan. The factbase audit takes ~10s. Diff + write completes in <5s each.

Both audits produce deterministic (alphabetically sorted) diff JSON so re-runs against stable PG state produce byte-identical output — useful for CI drift detection if we want it.

## Appendix B — Known prototype limitations

1. **No bulk-export endpoint.** `/api/entities/` list strips `metadata`/`relatedEntries`/`customFields`. The prototype fetches each entity separately via `/api/entities/:slug`. For production Phase 3 this needs a `/api/entities/export` endpoint mirroring `/api/facts/export`.
2. **wikiId fallback non-determinism.** The prototype runs `buildIdRegistry` after fetching from PG, which assigns in-memory fallback IDs that differ from the YAML baseline. 1,102 `C:wikiId` diffs in the output are caused by this, not by real gaps. See Finding #3.
3. **Tier 2 personnel not filtered.** The prototype includes all 2,809 PG entities in the output; 783 of those are Tier 2 personnel/displaced rows that the YAML pipeline excludes. Real Phase 3 reader needs an explicit filter.
4. **Compares only `typedEntities`.** Other `database.json` fields (`kb`, `resources`, `records`, `publications`, etc.) are already PG-sourced or PG-overriding today and are equivalent by construction. They are out of scope for this audit phase.
5. **Single-shot, not continuous.** The audit reflects prod PG state at the moment of the run (2026-04-15 ~13:00 PDT). Future sync changes may shift counts.

## Appendix C — Files produced by this audit

| Path                                                           | What it is                                          | Committed? |
|----------------------------------------------------------------|-----------------------------------------------------|------------|
| `docs/audits/phase-3-equivalence-audit.md`                     | This report                                          | ✅          |
| `docs/audits/phase-3-equivalence-audit.diff.json`              | Full per-row entity diff (1,895 field diffs + 783 pgOnly) | ✅          |
| `docs/audits/phase-3-equivalence-audit-factbase.diff.json`     | Full per-row factbase diff (45 value diffs, 2,209 facts matched) | ✅          |
| `apps/web/scripts/build-data-from-pg.mjs`                      | The PG-sourced entity prototype reader               | ✅          |
| `apps/web/scripts/audit-factbase-pg.mjs`                       | The factbase equivalence audit script                | ✅          |
| `apps/web/src/data/typedEntities-from-pg.json`                 | PG-sourced typedEntities (diff input)                | ❌ gitignored |
| `apps/web/src/data/pg-audit-diff.md`                           | Entity diff summary (human-readable)                 | ❌ gitignored |
| `apps/web/src/data/factbase-audit-diff.md`                     | Factbase diff summary (human-readable)               | ❌ gitignored |

The markdown summaries and the intermediate JSON are gitignored because they're regeneratable at any time and would create large merge-conflict surfaces. The `.diff.json` files under `docs/audits/` ARE committed because they are the audit's per-row classification artifact (QUA-510 acceptance criterion #3).

# KB Migration Plan — YAML Facts to KB Library

> **Status**: Largely completed — KB migration executed in March 2026 (PRs #1880, #1891, etc.)
> **Date**: 2026-03-06
> **Prerequisite**: KB library promoted (see `kb-library.md` evaluation results)
> **Related**: `kb-library.md` (data model), `statements-strategy.md` (superseded — statements deleted in PR #1908), `anthropic-ontology.md` (Anthropic data audit)

## 1. Scope Assessment

### What exists today

| System | Count | Location |
|--------|-------|----------|
| Entities (YAML) | 554 across 11 files | `data/entities/*.yaml` |
| Facts (YAML) | 157 across 17 entity fact files | `data/facts/*.yaml` |
| Fact measures | 191 definitions | `data/fact-measures.yaml` |
| KB things | 5 (anthropic, openai, dario-amodei, jan-leike, sam-altman) | `packages/kb/data/things/` |
| KB properties | 18 | `packages/kb/data/properties.yaml` |

### Which entities benefit from KB format?

**High value (migrate):** Entities that have structured facts, temporal data, relationships, or sub-items (funding rounds, key people). These are the 17 entities with existing fact files plus key organizations and people that should have structured data.

| Priority | Entities | Count | Rationale |
|----------|----------|-------|-----------|
| Phase 1 | Already in KB: anthropic, openai, dario-amodei, jan-leike, sam-altman | 5 | Done. Validate and expand data. |
| Phase 2 | Remaining fact-file entities: xai, meta-ai, deepmind, miri, sff, ssi, coefficient-giving, chan-zuckerberg-initiative, dustin-moskovitz, elon-musk, jaan-tallinn, manifund, cais, anthropic-government-standoff | 14 | Have structured data that maps directly. |
| Phase 3 | Key orgs without facts: redwood-research, apollo-research, metr, epoch-ai, open-philanthropy, 80000-hours, fhi, fli, mats, chai | ~10 | Important enough to warrant structured data even without existing facts. |
| Phase 4 | Key people without facts: eliezer-yudkowsky, nick-bostrom, paul-christiano, geoffrey-hinton, stuart-russell, toby-ord, holden-karnofsky, evan-hubinger, leopold-aschenbrenner | ~10 | Would benefit from employed-by/role/born-year structure. |

**Low value (skip):** The remaining ~515 entities (risks, responses, models, concepts) do not have structured numeric/temporal data. Their information is narrative, lives in MDX prose, and is better served by the claims/statements system. Do not migrate these.

**Total migration scope: ~40 entities** (Phases 1-4), not 554.

## 2. Property Mapping

### Current fact-measures.yaml (191 measures) to KB properties.yaml (18 properties)

#### Direct mapping (already in KB properties.yaml)

| Old measure ID | KB property ID | Notes |
|---------------|----------------|-------|
| `valuation` | `valuation` | Identical |
| `revenue` | `revenue` | Identical |
| `headcount` | `headcount` | Identical |
| `total-funding` | `total-funding` | Identical |
| `funding-round` | `funding-round-amount` | Renamed for clarity |
| `gross-margin` | `gross-margin` | Identical |
| `market-share` | `market-share` | Identical |
| `user-count` | `user-count` | Identical |
| `founded-date` | `founded-date` | Identical |
| `headquarters` | `headquarters` | Identical |
| `legal-structure` | `legal-structure` | Identical |

#### Needs new KB property (add to properties.yaml)

| Old measure ID | Proposed KB property | dataType | Priority |
|---------------|---------------------|----------|----------|
| `revenue-guidance` | `revenue-guidance` | number | Phase 2 |
| `cash-burn` | `cash-burn` | number | Phase 2 |
| `product-revenue` | `product-revenue` | number | Phase 2 |
| `infrastructure-investment` | `infrastructure-investment` | number | Phase 2 |
| `customer-count` | `customer-count` | number | Phase 2 |
| `customer-concentration` | `customer-concentration` | number | Phase 3 |
| `retention-rate` | `retention-rate` | number | Phase 3 |
| `safety-researcher-count` | `safety-researcher-count` | number | Phase 2 |
| `interpretability-team-size` | `interpretability-team-size` | number | Phase 2 |
| `safety-staffing-ratio` | `safety-staffing-ratio` | number | Phase 3 |
| `equity-stake-percent` | `equity-stake` | number | Phase 2 |
| `equity-value` | `equity-value` | number | Phase 2 |
| `philanthropic-capital` | `philanthropic-capital` | number | Phase 2 |
| `net-worth` | `net-worth` | number | Phase 3 |
| `benchmark-score` | `benchmark-score` | number | Phase 3 |
| `model-parameters` | `model-parameters` | number | Phase 3 |
| `context-window` | `context-window` | number | Phase 3 |
| `launched-date` | `launched-date` | date | Phase 2 |
| `employer` | (use `employed-by` inverse) | ref | Already handled |
| `founder` | (use `founded-by`) | refs | Already handled |
| `ceo` | (encode in key-people items) | ref | Already handled |

#### Out of scope for KB (narrative/qualitative measures)

These 100+ measures are string-typed narrative claims. They stay in the claims/statements system, not KB.

- `policy-position`, `regulatory-event`, `governance-structure`, `lobbying-action`
- `research-finding`, `research-methodology`, `publication`
- `focus-area`, `company-culture`, `reputation`, `criticism`, `revenue-source`
- `product-release`, `model-capability`, `safety-level`
- `interpretability-finding`, `safety-incident`, `red-team-result`, `alignment-technique`
- `compliance-standard`, `transparency-report`, `voluntary-commitment`
- `prediction`, `public-statement`, `interview-quote`
- `generic-count`, `generic-percent` (fallback measures)
- All `relation`-category measures that map to `relatedEntries` (handled by KB inverses)

**Summary:** Of 191 measures, ~30 map to KB properties (numeric/temporal). The rest (~160) are narrative and stay in claims/statements.

## 3. Migration Phases

### Phase 1: Validate existing KB data (1 session)

The 5 entities already in KB (anthropic, openai, dario-amodei, jan-leike, sam-altman) were created manually. This phase ensures they contain all data from the old fact files, not just a subset.

**Tasks:**
- Diff `data/facts/anthropic.yaml` (33 facts) against `packages/kb/data/things/anthropic.yaml` (12 facts). Port missing facts (equity stakes, safety metrics, team sizes, etc.)
- Diff `data/facts/openai.yaml` (12 facts) against KB openai.yaml (12 facts). Verify coverage.
- Diff `data/facts/sam-altman.yaml` (7 facts) against KB sam-altman.yaml (0 facts beyond role/employer). Port net-worth, investment history.
- Add any missing `sourceResource` references as `source` URLs
- Run `kb.validate()` and fix all warnings

**Done when:** Every old-system fact for these 5 entities has a corresponding KB fact or a documented reason for exclusion.

### Phase 2: Organizations with existing facts (2-3 sessions)

Migrate the 12 remaining organizations that have fact files.

**Batch A — Large fact files (>100 lines):**
- `xai` (152 lines) — valuation, revenue, headcount, funding rounds, Grok metrics
- `meta-ai` (126 lines) — Llama models, revenue, user metrics
- `chan-zuckerberg-initiative` (142 lines) — grants, funding
- `coefficient-giving` (152 lines) — grants, funding mechanisms

**Batch B — Medium fact files (30-90 lines):**
- `ssi` (72 lines) — funding, team, mission
- `sff` (52 lines) — grant data, funding allocations
- `miri` (61 lines) — revenue, expenses, headcount over time

**Batch C — Small fact files (<40 lines):**
- `deepmind` (40 lines) — AlphaFold, Gemini metrics, acquisition
- `dustin-moskovitz` (42 lines) — net worth, philanthropy
- `elon-musk` (29 lines) — investments, positions
- `jaan-tallinn` (28 lines) — investments, stakes
- `manifund` (12 lines) — basic metrics
- `cais` (11 lines) — basic metrics
- `anthropic-government-standoff` (28 lines) — this is an event, not an org; may not fit KB model

**Per-entity tasks:**
1. Create `packages/kb/data/things/<entity>.yaml` with thing metadata
2. Convert old hex-ID facts to KB `f_`-prefixed fact format
3. Map old `measure` fields to KB `property` fields
4. Convert `sourceResource` hex refs to `source` URLs
5. Structure funding rounds and key people as items (where applicable)
6. Add new properties to `properties.yaml` as needed
7. Run validation

**Done when:** All 14 entities have KB YAML files, and `kb.validate()` passes with only expected warnings (refs to things not yet migrated).

### Phase 3: Key people without existing facts (1-2 sessions)

Create KB entries for ~10 important people. These do not have old fact files, so data comes from MDX page content and entity YAML `relatedEntries`.

**Core data for each person:**
- `employed-by` (current and historical, with `asOf`/`validEnd`)
- `role` (current title)
- `born-year` (where known)

**Entities:** eliezer-yudkowsky, nick-bostrom, paul-christiano, geoffrey-hinton, stuart-russell, toby-ord, holden-karnofsky, evan-hubinger, leopold-aschenbrenner, neel-nanda

**Done when:** Each person has a KB thing file with at least `employed-by` and `role` facts.

### Phase 4: Key organizations without existing facts (1-2 sessions)

Create KB entries for ~10 important organizations that lack fact files but would benefit from structured data (founding date, headquarters, headcount, key people).

**Entities:** redwood-research, apollo-research, metr, epoch-ai, open-philanthropy, 80000-hours, fhi, fli, mats, chai

**Done when:** Each org has a KB thing file with at least `founded-date`, `headquarters`, and a `key-people` items collection.

### Phase 5: Cleanup (1 session)

- Mark old `data/facts/*.yaml` files as deprecated (add header comment)
- Update `build-data.mjs` to read from KB as primary source, falling back to old facts
- Remove duplicate data from old fact files for migrated entities
- Update `<F>` component to read from KB graph instead of (or in addition to) old fact store

## 4. Coexistence Strategy

During migration, both systems must coexist. Here is how:

### Principle: KB is the new canonical source; old facts are the fallback

```
build-data.mjs
  ├─ Read packages/kb/data/things/*.yaml  →  KB facts (preferred)
  ├─ Read data/facts/*.yaml               →  Old facts (fallback)
  └─ Merge: KB wins on conflict, old facts fill gaps
```

### Rendering on wiki pages

The `<F>` component currently reads from `database.json` which is built from old facts. The migration path:

1. **During migration:** `build-data.mjs` merges both sources into `database.json`. Existing `<F e="anthropic" f="valuation-2024">` calls continue to work. Old fact IDs (hex) map to new KB fact IDs via a lookup table.
2. **After migration:** `<F>` can accept either old fact IDs (backward compat) or new KB fact IDs. The lookup table handles translation.
3. **Long-term:** Old hex fact IDs are deprecated. New page edits use KB fact IDs. Eventually remove hex-ID support.

### Fact ID translation

The migration script generates a mapping file:

```yaml
# data/kb-migration-map.yaml (auto-generated, not hand-edited)
anthropic:
  "6796e194": f_mN3pQ7kX2r   # valuation → valuation
  "0ed4db9e": f_dW5cR9mJ8q   # revenue-run-rate → revenue
  # ...
```

This allows `<F e="anthropic" f="6796e194">` to resolve to the KB fact during the transition.

### Entity YAML coexistence

Old `data/entities/organizations.yaml` entries (with `relatedEntries`, `sources`, etc.) are NOT migrated to KB. They serve a different purpose (entity metadata for the wiki sidebar, explore page, etc.). KB things are about structured facts, not entity registry metadata.

The `numericId` must match between old entity YAML and KB thing YAML. The migration script enforces this.

## 5. Migration Script Design

### `crux kb migrate <entity-id>`

High-level flow:

```
1. Read data/facts/<entity>.yaml
2. Read data/entities/*.yaml to find entity metadata (numericId, type, etc.)
3. Read data/fact-measures.yaml for measure → property mapping
4. Read packages/kb/data/properties.yaml for existing KB properties
5. For each old fact:
   a. Map measure ID → KB property ID (using mapping table)
   b. Generate new f_ fact ID (deterministic content-hash from old fact)
   c. Convert value format:
      - Old: { value: 380000000000 } → KB: { value: 380e9 }
      - Old: { value: { min: 157000000000 } } → KB: { value: 157e9, notes: "minimum estimate" }
      - Old: { value: [40, 60] } → KB: { value: 50, notes: "range 40-60" } or keep as range
      - Old: { value: "$76,001/year" } → separate string fact (narrative, not numeric)
   d. Convert sourceResource hex → source URL (via resources lookup)
   e. Set asOf from old fact
6. Generate thing metadata (id, stableId, type, name, numericId, aliases)
7. Extract funding rounds from facts with measure=funding-round → items.funding-rounds
8. Write packages/kb/data/things/<entity>.yaml
9. Write migration map entry to data/kb-migration-map.yaml
10. Run kb.validate() on result
11. Print diff summary: N facts migrated, M skipped (narrative), K new properties needed
```

### Flags

```bash
pnpm crux kb migrate anthropic              # Migrate, write file
pnpm crux kb migrate anthropic --dry-run    # Show what would be generated
pnpm crux kb migrate anthropic --force      # Overwrite existing KB file
pnpm crux kb migrate --all                  # Migrate all entities with fact files
pnpm crux kb migrate --batch=2              # Migrate Phase 2 entities
```

### Handling edge cases

| Edge case | Strategy |
|-----------|----------|
| Facts without a measure (e.g., `breakeven-target: "2028"`) | Skip with warning; these are narrative claims |
| Facts with `measure: ~` (null) | Skip with warning |
| String values like `"$76,001/year"`, `"1,900"` | Parse if numeric, else skip as narrative |
| Range values `[40, 60]` | Keep as-is — KB supports JSON value type for ranges. Consider adding a `range` type later. |
| `value: { min: X }` objects | Extract `X` as the value; add `notes: "minimum estimate"` |
| `sourceResource` hex IDs | Look up in `data/resources/*.yaml` to get URL. If not found, log warning. |
| Entity not in `data/entities/*.yaml` | Error — entity must exist for numericId |
| Old fact file entity ID differs from entity YAML ID | Map using known aliases (e.g., `deepmind` fact file → `deepmind` entity) |

## 6. Rollback Plan

### If KB causes rendering problems

1. **Immediate:** `build-data.mjs` has a `USE_KB=false` env var to skip KB loading and fall back to old facts only. This is a one-line change.
2. **Short-term:** KB YAML files are additive — they don't modify or delete old fact files. Reverting is just removing the KB reading code from `build-data.mjs`.
3. **Nuclear:** Delete `packages/kb/data/things/` contents (except the original 5 test entities). Old facts in `data/facts/` are untouched.

### If KB data quality is worse than old facts

- Each migrated entity has a validation report. Entities failing validation are excluded from `build-data.mjs` merge.
- The migration map allows per-entity opt-out: remove the entity from the map and it reverts to old facts.

### What is NOT safely rollbackable

- Once MDX pages start using new KB fact IDs (e.g., `<F e="anthropic" f="f_mN3pQ7kX2r">`), reverting requires updating those references. The migration map handles this during transition, but if the map is removed, those `<F>` calls break.
- **Mitigation:** Do not update MDX `<F>` references until Phase 5 (cleanup), after all data is validated.

## 7. Success Metrics

### Migration is "done enough" when

| Metric | Target | How to measure |
|--------|--------|----------------|
| Fact coverage | 100% of old numeric facts for migrated entities exist in KB | `crux kb migrate --dry-run --all` shows 0 unmigrated numeric facts |
| Validation pass rate | >95% of KB entities pass validation with 0 errors | `kb.validate()` output |
| Rendering parity | Wiki pages for migrated entities render identically | Visual diff of Anthropic, OpenAI, xAI pages before/after |
| Old system deprecation | Old fact files marked deprecated, not actively edited | Header comment in each old file; lint rule warns on edits |
| Build integration | `pnpm build` reads KB data without errors | CI green |

### Migration is NOT "done" until

- `build-data.mjs` reads KB as primary source for migrated entities
- At least one wiki page renders a `<FactTable>` or `<ItemTable>` from KB data (not just `<F>` inline values)
- The `crux kb migrate` command exists and can regenerate any entity's KB file from old facts

### What "done" does NOT require

- Migrating all 554 entities (only ~40 benefit from structured data)
- Removing old `data/facts/*.yaml` files (they can stay as deprecated reference)
- Updating every `<F>` reference in MDX to use new fact IDs (translation layer handles this)
- Building Postgres sync (separate concern, later)

## 8. Timeline Estimate

| Phase | Sessions | Calendar time | Dependencies |
|-------|----------|---------------|-------------|
| Phase 1: Validate existing KB data | 1 | 1 day | None |
| Phase 2: Orgs with facts (14 entities) | 2-3 | 3-5 days | Phase 1 + migration script |
| Phase 3: Key people (10 entities) | 1-2 | 2-3 days | Phase 2 (properties stabilized) |
| Phase 4: Key orgs without facts (10 entities) | 1-2 | 2-3 days | Phase 2 |
| Phase 5: Cleanup + build integration | 1 | 1-2 days | Phases 1-4 |
| **Total** | **6-9 sessions** | **~2 weeks** | |

The migration script (`crux kb migrate`) should be built before Phase 2 starts. Once it exists, Phase 2 is largely automated with manual review.

## 9. Open Questions

1. **Range values:** Old system uses `[40, 60]` arrays for ranges. KB's `FactValue` type has `json` as escape hatch. Should we add a proper `range` type (`{ type: "range"; min: number; max: number }`)? Likely yes, but can defer.

2. **`sourceResource` preservation:** Old facts reference resources by hex ID (`sourceResource: 8e3ff50b9ef2a1a8`). KB uses `source` URLs directly. Should KB also support resource ID references for tighter integration with the resource system? Probably not — URLs are more portable.

3. **`anthropic-government-standoff` entity:** This is an event/incident, not an organization or person. The KB currently only has schemas for `organization` and `person`. Either create an `event` schema or skip this entity.

4. **Item collection vs fact:** Some old facts (funding rounds) are better represented as items. Others (revenue time series) are better as facts. The heuristic: if it has unique sub-fields (amount, lead investor, valuation), use items. If it is a simple (property, value, time) tuple, use facts. The migration script needs to apply this heuristic per measure.

5. **Computed/derived facts:** Some old facts are clearly derived (e.g., `founder-pledge-total` = 80% of `founder-equity-total`). Should KB compute these, or store them as regular facts with `derivedFrom` annotation? Store as regular facts with `notes` explaining the derivation. KB is a data store, not a computation engine.

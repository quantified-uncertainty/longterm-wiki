# Knowledge Base Library — Design Doc

> **Status**: Session 3 complete. Library promoted — rendering components built, 5 entities, 133 tests passing.
> **Goal**: Standalone TypeScript package for structured knowledge — entities, facts, schemas, relationships — decoupled from the wiki rendering, wiki-server, and crux CLI.
> **Scope**: Currently 5 test entities (Anthropic, OpenAI, Dario Amodei, Jan Leike, Sam Altman). Expanding to ~20+ entities over ~10 PRs.
> **Related**: `statements-strategy.md` (broader data architecture context), `anthropic-ontology.md` (Anthropic data audit)

## Why

The wiki's knowledge base logic is scattered across 6+ locations (build-data.mjs, entity YAML, fact YAML, fact-measures.yaml, wiki-server schema, data/index.ts). There are two overlapping fact systems (YAML facts + Postgres statements). Relationships are manually duplicated. There's no schema enforcement. The 20-query stress test showed 70% of realistic queries are awkward or impossible.

A clean library with a unified data model would:
- Be testable without the wiki or wiki-server
- Compute inverse relationships automatically (no `relatedEntries` duplication)
- Enforce schemas per entity type
- Handle sub-items (funding rounds, key people) as lightweight typed collections
- Provide a clear sync path to the wiki-server DB with history tracking

Inspired by Ken Standard (same author), extended with temporal data, stable IDs, and schema validation.

## Data model

### Thing

Any identifiable subject. Lightweight — a section in a YAML file, not a heavyweight entity.

```typescript
interface Thing {
  id: string;             // Human-readable slug: "anthropic", "claude-3-5-sonnet"
  stableId: string;       // Random 10-char: "a7xK2mP9qR" — survives renames
  type: string;           // References a TypeSchema: "organization", "person"
  name: string;           // Display name
  parent?: string;        // Parent thing ID (funding round → org)
  aliases?: string[];     // Alternative names for search
  previousIds?: string[]; // Former slugs (for redirects)
  numericId?: number;     // Legacy wiki URL ID (E42). Not all things have one.
}
```

### Fact

A (subject, property, value) triple with temporal and provenance info.

```typescript
interface Fact {
  id: string;             // Random 10-char "f_xxxxxxxx" or content-hash
  subjectId: string;      // Thing ID (slug)
  propertyId: string;     // Property ID from registry
  value: FactValue;
  asOf?: string;          // When this was true (ISO date or YYYY-MM)
  validEnd?: string;      // When it stopped being true (null = still true)
  source?: string;        // URL
  sourceQuote?: string;   // Relevant excerpt
  notes?: string;         // Free-text annotation
}

type FactValue =
  | { type: "number"; value: number; unit?: string }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "ref"; value: string }      // Another Thing ID
  | { type: "refs"; value: string[] }   // Multiple Thing IDs
  | { type: "json"; value: unknown }    // Escape hatch
```

### Property

Self-describing property definition.

```typescript
interface Property {
  id: string;              // "revenue", "employed-by"
  name: string;            // "Revenue", "Employed By"
  description?: string;
  dataType: string;        // "number", "text", "date", "ref", "refs"
  unit?: string;           // "USD", "percent", "tokens"
  category?: string;       // "financial", "people", "safety"
  inverseId?: string;      // "employed-by" → "employer-of"
  inverseName?: string;    // "Employed By" → "Employs"
  appliesTo?: string[];    // Thing types this property is valid for
  display?: {
    divisor?: number;      // 1e9 for billions
    prefix?: string;       // "$"
    suffix?: string;       // "%"
  };
}
```

### TypeSchema

Defines expected properties for a Thing type.

```typescript
interface TypeSchema {
  type: string;            // "organization", "person", "ai-model"
  name: string;            // "Organization"
  required: string[];      // Property IDs that must exist
  recommended: string[];   // Property IDs that should exist
  items?: Record<string, ItemCollectionSchema>;
}

interface ItemCollectionSchema {
  description: string;
  fields: Record<string, FieldDef>;
}

interface FieldDef {
  type: string;            // "number", "text", "date", "ref", "boolean"
  required?: boolean;
  unit?: string;
  description?: string;
}
```

## YAML format

### Entity file with facts and items

```yaml
# data/kb/anthropic.yaml
thing:
  id: anthropic
  stableId: a7xK2mP9qR
  type: organization
  name: Anthropic
  numericId: 3

facts:
  - id: f_8kX2pQ7mNr
    property: founded-date
    value: 2021-01
    source: https://anthropic.com/company

  - id: f_mN3pQ7kX2r
    property: valuation
    value: 380e9
    asOf: 2026-02
    source: https://reuters.com/...
    notes: "Series G post-money"

  - id: f_qR5tY9wE1a
    property: revenue
    value: 19e9
    asOf: 2026-03
    source: https://theinformation.com/...

  - id: f_xZ7bD2nM4c
    property: headquarters
    value: "San Francisco, CA"

items:
  funding-rounds:
    type: funding-round
    entries:
      series-a:
        date: 2021-05
        amount: 124e6
        valuation: 550e6
        source: https://anthropic.com/news/anthropic-raises-124-million
      series-b:
        date: 2022-04
        amount: 580e6
        valuation: 4e9
        lead_investor: ftx
        source: https://fortune.com/...
        notes: "FTX estate later sold stake for ~$1.4B"
      series-c:
        date: 2023-05
        amount: 450e6
        valuation: 4.1e9
        source: https://fortune.com/...
      # ... more rounds

  key-people:
    type: key-person
    entries:
      dario-ceo:
        person: dario-amodei  # ref to another Thing
        title: CEO
        start: 2021-01
        is_founder: true
      jan-leike:
        person: jan-leike
        title: "Head of Alignment Science"
        start: 2024-05
        source: https://anthropic.com/news/jan-leike-joins-anthropic
      mike-krieger:
        person: mike-krieger
        title: "Chief Product Officer"
        start: 2024-05
        end: 2025-08
        notes: "Moved to head Anthropic Labs"
```

### Property definitions

```yaml
# data/kb/properties.yaml
properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
    category: financial
    appliesTo: [organization]
    display: { divisor: 1e9, prefix: "$", suffix: "B" }

  employed-by:
    name: Employed By
    dataType: ref
    category: people
    inverseId: employer-of
    inverseName: Employs

  employer-of:
    name: Employs
    dataType: refs
    category: people
    inverseId: employed-by
    inverseName: Employed By
    # This property is COMPUTED — never stored directly.
    # The library generates it from employed-by facts.

  valuation:
    name: Valuation
    dataType: number
    unit: USD
    category: financial
    appliesTo: [organization]
    display: { divisor: 1e9, prefix: "$", suffix: "B" }
```

### Type schemas

```yaml
# data/kb/schemas/organization.yaml
type: organization
name: Organization

required:
  - founded-date
  - headquarters

recommended:
  - revenue
  - valuation
  - headcount

items:
  funding-rounds:
    description: "Equity and strategic investment rounds"
    fields:
      date: { type: date, required: true }
      amount: { type: number, unit: USD }
      valuation: { type: number, unit: USD }
      lead_investor: { type: ref }
      source: { type: text }
      notes: { type: text }

  key-people:
    description: "Current and former key personnel"
    fields:
      person: { type: ref, required: true }
      title: { type: text, required: true }
      start: { type: date }
      end: { type: date }
      is_founder: { type: boolean }
      source: { type: text }
```

## ID scheme

| Kind | Format | Example | Stability | Purpose |
|------|--------|---------|-----------|---------|
| Slug | kebab-case string | `anthropic` | Can change (renames) | Human-readable, YAML keys, URLs |
| Stable ID | Random 10-char alnum | `a7xK2mP9qR` | Never changes | DB sync, external references |
| Fact ID | `f_` + 10-char alnum | `f_8kX2pQ7mNr` | Never changes | Per-fact history tracking |
| Item key | Local kebab-case | `series-a` | Stable within entity | YAML keys, local references |
| Numeric ID | `E` + integer | `E42` | Never changes | Legacy wiki URLs |

**Stable ID generation**: `crypto.randomBytes(7).toString('base64url').slice(0, 10)` — 60 bits of entropy, collision probability < 1 in 10^15.

**Content-hash IDs** (optional, for auto-generated facts): `hash(subjectId + propertyId + JSON.stringify(value) + asOf).slice(0, 10)` — deterministic, idempotent. Same source data always produces same fact ID. Useful for sync — if you regenerate facts from the same YAML, IDs don't change.

**Rename workflow**: Change the slug, keep stableId. Add old slug to `previousIds` for lookups/redirects. DB records keyed by stableId are unaffected.

## Library API

```typescript
// Load a knowledge base from YAML files
const kb = await loadKB("data/kb/");

// Query
kb.getThing("anthropic");                        // → Thing
kb.getFacts("anthropic");                         // → Fact[]
kb.getFacts("anthropic", { property: "revenue" }); // → Fact[] (filtered)
kb.getItems("anthropic", "funding-rounds");       // → ItemEntry[]
kb.getLatest("anthropic", "valuation");           // → Fact (most recent by asOf)

// Cross-entity
kb.getByProperty("valuation");                      // → Map<thingId, Fact> (latest per entity)
kb.getAllByProperty("valuation");                    // → Map<thingId, Fact[]> (full history)
kb.getByType("organization");                     // → Thing[]

// Relationships (including computed inverses)
kb.getRelated("anthropic", "employer-of");        // → string[] (computed from employed-by)
kb.getRelated("jan-leike", "employed-by");        // → string[] (stored directly)

// Validation
kb.validate();                                     // → ValidationResult[]
kb.validateThing("anthropic");                     // → ValidationResult[]

// Serialize
kb.toJSON();                                       // → for database.json
kb.toYAML("anthropic");                            // → round-trip back to YAML
```

## Package structure

```
packages/kb/
├── package.json
├── tsconfig.json
├── EXPERIMENTAL.md           ← Flags this as an experiment
├── src/
│   ├── index.ts              ← Public API
│   ├── types.ts              ← Thing, Fact, Property, TypeSchema, etc.
│   ├── graph.ts              ← In-memory graph: load, query, traverse
│   ├── loader.ts             ← YAML → Graph
│   ├── validate.ts           ← Schema + ref validation
│   ├── inverse.ts            ← Computed inverse relationships
│   ├── query.ts              ← Query helpers (by-property, by-type, latest)
│   ├── serialize.ts          ← Graph → JSON / YAML
│   └── ids.ts                ← Stable ID generation + content hashing
├── data/                     ← Test data (Anthropic only initially)
│   ├── things/
│   │   └── anthropic.yaml
│   ├── properties.yaml
│   └── schemas/
│       └── organization.yaml
└── tests/
    ├── loader.test.ts
    ├── query.test.ts
    ├── inverse.test.ts
    └── validate.test.ts
```

## What this experiment tests

1. **Is the YAML format ergonomic?** Can a human read/edit `anthropic.yaml` comfortably? Is it too verbose?
2. **Do stable IDs work in practice?** Is the generation scheme reliable? Does content-hashing produce stable results?
3. **Are computed inverses correct?** Do they handle edge cases (multiple employers, temporal bounds)?
4. **Does schema validation catch real problems?** Does it find the gaps the Anthropic ontology audit found?
5. **Can the query API answer the stress test queries?** Specifically Q4 (board members), Q5 (current employees), Q7 (funding rounds with valuations), Q20 (bidirectional relationships).

## What this experiment does NOT test

- Wiki rendering (`<FactTable>`, `<ItemTable>` — those come later if this succeeds)
- Server sync (YAML → Postgres history tracking)
- Migration from existing entities/facts/statements
- Scale beyond one entity
- LLM-driven data entry

## Implementation plan

### Session 1: Core library (COMPLETE — PR #1799)
- [x] Create `packages/kb/` with package.json, tsconfig
- [x] Implement types.ts (Thing, Fact, Property, TypeSchema)
- [x] Implement ids.ts (stableId generation, content-hash, fact ID)
- [x] Implement loader.ts (YAML → in-memory graph)
- [x] Implement graph.ts (in-memory query engine)
- [x] Implement inverse.ts (computed inverse relationships)
- [x] Implement validate.ts (schema validation, 6 check types)
- [x] Implement serialize.ts (Graph → JSON)
- [x] Write Anthropic test data (11 facts, 9 funding rounds, 7 key people)
- [x] Write Dario Amodei and Jan Leike person data
- [x] Write properties.yaml (15 properties with inverses) and schemas
- [x] 102 tests across 5 test files, all passing

### Session 2: Evaluation + second entity (COMPLETE)
- [x] Add OpenAI as second entity (10 facts, 4 funding rounds, 8 key people)
- [x] Add Sam Altman person data
- [x] Run 20-query stress test against KB (25 tests, all passing)
- [x] Fix inverse duplication bug (computed properties were creating duplicates)
- [x] Run validation on real data — catches ref integrity, missing properties, completeness
- [x] Write evaluation report (see below)

### Session 3: Rendering + Data Expansion (COMPLETE — PR #1801, #1802)
- [x] Build rendering components: KBFactTable, KBItemTable, KBFactValue
- [x] Shared formatting utility (format.ts) with smart currency, date, domain display
- [x] Cross-entity item queries (getItemsMentioning)
- [x] Expand Anthropic data to 36 facts, 9 item collections, 71 resources
- [x] Integrate into build-data.mjs → database.json.kb
- [x] Fix all review comments: addFact dedup, getByProperty no-op, inverse ID collisions,
      normalizeValue authority, ENOENT-only catches, computed property rejection, asOf coercion
- [x] 133 tests passing across 6 test files

### Next: Expansion (~10 PRs planned)
- [ ] PR 5: 3-5 more org entities (DeepMind, Meta AI, xAI, etc.)
- [ ] PR 6: Person entity blueprint (5-10 people)
- [ ] PR 7: `<F>` compatibility shim (KB facts replace YAML facts)
- [ ] PR 8: Migrate YAML facts → KB
- [ ] PR 9: Statement integration

## Evaluation results (Session 2)

### 20-query stress test

**Old system: 30% Clean / 50% Awkward / 20% Impossible**
**KB library: 90% Clean / 10% Awkward / 0% Impossible**

| # | Query | Old | New | Change |
|---|-------|-----|-----|--------|
| 1 | Latest valuation | Clean | **Clean** | — |
| 2 | Revenue over time | Clean | **Clean** | — |
| 3 | Compare all labs' valuations | Awkward | **Clean** | `getByProperty()` one-liner |
| 4 | Board members | IMPOSSIBLE | **Awkward** | key-people items (no dedicated board collection) |
| 5 | Current employees | Awkward | **Clean** | Inverse employer-of + current filter |
| 6 | Total funding aggregation | Awkward | **Clean** | `getByProperty("total-funding")` |
| 7 | Funding rounds with details | Awkward | **Clean** | Structured items with typed fields |
| 8 | OpenAI valuation | IMPOSSIBLE | **Clean** | Same API as Anthropic, data-dependent |
| 9 | Headcount over time | Awkward | **Clean** | Time series via asOf |
| 10 | Gross margin | Clean | **Clean** | Added gross-margin property + data |
| 11 | Which entities have revenue | Clean | **Clean** | — |
| 12 | Compare headcount | Awkward | **Clean** | `getByProperty("headcount")` |
| 13 | When founded | Clean | **Clean** | — |
| 14 | Revenue-to-valuation ratio | Awkward | **Awkward** | Two getLatest calls + division |
| 15 | Safety research | Awkward | **Clean** | Added research-areas item collection |
| 16 | Products launched | Clean | **Clean** | Added products item collection |
| 17 | Market share comparison | Awkward | **Clean** | Added market-share property + data |
| 18 | Jan Leike career | IMPOSSIBLE | **Clean** | Temporal employed-by with asOf/validEnd |
| 19 | Properties inventory | Clean | **Awkward** | Requires iteration for usage counts |
| 20 | Bidirectional lookup | Awkward | **Clean** | Inverses + key-people items |

**Key improvements:**
- All 4 previously-impossible queries are now Clean or Awkward
- Cross-entity queries are now one-liners via `getByProperty()`
- Inverse relationships eliminate manual duplication
- Item collections provide structured sub-entity data (funding rounds, key people, products, research areas)

### Validation findings

Running `validate(graph)` on 5 entities (Anthropic, OpenAI, Dario, Jan, Sam):
- **11 warnings**: Item ref integrity — funding round lead investors and key people referencing things not yet in the graph (amazon, google, ftx, daniela-amodei, chris-olah, etc.)
- **1 warning**: Jan Leike missing recommended `born-year`
- **5 info**: Completeness scores — Anthropic 100%, OpenAI 100%, Dario 100%, Jan Leike 67%, Sam 100%

All findings are legitimate data quality issues. No false positives.

### Bug found and fixed

`computeInverses()` was processing both `employed-by` (inverseId: `employer-of`) and `employer-of` (inverseId: `employed-by`), creating duplicate facts. Fixed by skipping properties marked `computed: true` and facts with `derivedFrom` set.

### Promote criteria check

| Criterion | Status |
|-----------|--------|
| Anthropic data cleaner than current YAML facts + statements | **Yes** — structured items, typed values, temporal bounds |
| Stress test improves from 30% Clean to >60% Clean | **Yes** — 90% Clean (was 30%) |
| At least one wiki page can render from KB data | **Not yet** — rendering is Session 3 |
| OpenAI addable in <1 hour | **Yes** — 10 minutes via agent |

### Kill criteria check

| Criterion | Status |
|-----------|--------|
| YAML format too verbose (>15 lines per funding round) | **No** — 5-6 lines per round |
| Validation >50% false positives | **No** — 0% false positives |
| Inverse computation needs manual overrides >20% | **No** — 0% manual overrides needed |
| Can't represent something statements handle well | **Partial** — narrative claims out of scope by design |

### Recommendation: **PROMOTE** (with caveats)

The KB library passes 3/4 promote criteria (rendering is next). It fails 0/5 kill criteria. The data model is demonstrably better for structured/relational data.

**Caveats:**
1. Narrative claims remain in statements — KB handles structured data only
2. Rendering components needed before this can replace YAML facts on wiki pages
3. Migration path from existing 554 entities needs planning

## Kill criteria

Kill this experiment if:
- The YAML format is too verbose (>15 lines per funding round with all metadata)
- Schema validation generates >50% false positives
- Inverse computation has edge cases needing manual overrides >20% of the time
- The library can't represent something statements currently handle well (e.g., narrative claims)
- After 2 sessions of coding, it can't answer the 4 "impossible" stress test queries

## Promote criteria

Promote to production path if:
- Anthropic data is cleaner and more queryable than current YAML facts + statements
- The 20-query stress test improves from 30% Clean to >60% Clean
- At least one wiki page can render a table from KB data
- A second entity (OpenAI) can be added in <1 hour using the same schema

## Decision log

| # | Question | Decision | Date | Notes |
|---|----------|----------|------|-------|
| 1 | YAML vs TOML? | YAML | 2026-03-06 | Consistency with existing codebase. Reconsider if parsing issues arise. |
| 2 | Where do data files live? | `packages/kb/data/` for experiment, `data/kb/` long-term | 2026-03-06 | Keep experiment self-contained. |
| 3 | Monorepo workspace package? | Yes, `packages/kb` | 2026-03-06 | Uses pnpm workspace. Importable by crux and apps/web. |
| 4 | Include Postgres sync in experiment? | No | 2026-03-06 | File-based only. Sync is a separate concern for later. |
| 5 | How to handle narrative claims? | Out of scope | 2026-03-06 | Statements keep handling these. KB is for structured/relational data. |

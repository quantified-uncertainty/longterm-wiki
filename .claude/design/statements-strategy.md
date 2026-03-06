# Statements System: Strategy & Red-Teaming

> Living document. Updated across sessions. Goal: decide whether statements are the right data model for this wiki's structured data, and where they need to be supplemented or replaced.

## The fundamental question

We have a statement-based data model: every fact is a row with `(entity, property, value, date, text, citations)`. This is flexible and LLM-friendly, but is it actually the right representation for structured, relational data?

The alternative is traditional relational tables — a `funding_rounds` table, an `employment` table, a `model_specs` table — like Crunchbase. These are rigid but queryable, consistent, and natural for uniform data.

We're probably somewhere in between. The question is: **where's the boundary?**

## What we know so far (from the Anthropic exercise)

### Where statements work well

| Use case | Why it works |
|----------|-------------|
| Revenue time series | Uniform property, numeric values, temporal ordering. 10 statements make a clean chart. |
| Policy positions | Each one is different — SB 1047, SB 53, moratorium opposition. No common schema beyond "Anthropic took position X on date Y." |
| Safety incidents | One-off events, each unique. CVE, espionage attempt — can't schema-ify these. |
| Research publications | Each paper is different. Sleeper Agents, Scaling Monosemanticity — they share a property but the content is heterogeneous. |
| Interpretability findings | Similar to publications. Flexible, narrative-rich. |
| Market share snapshots | Simple time series, works fine as statements. |

**Pattern: Statements work when facts are heterogeneous, narrative-rich, or when the schema is uncertain.** You don't know in advance what properties a safety incident will have, so a flexible `(entity, property, value, text)` tuple is the right container.

### Where statements are awkward

| Use case | What's wrong | What tables would give you |
|----------|-------------|---------------------------|
| **Funding rounds + valuations** | Same event stored as 2 separate statements (funding-round, valuation). Must mentally join by date. 14 + 9 = 23 statements for 15 events. Date mismatches cause silent failures. | One row per event: `(date, series, amount, valuation, lead_investor)`. One table, 15 rows. |
| **Employment/positions** | "Jan Leike joined May 2024 as Alignment Lead" is one statement. But there's no structured person_id, no end_date, no departure tracking. Can't query "who works at Anthropic right now?" | `employment(person_id, org_id, title, start_date, end_date)`. Standard relational pattern. |
| **Model specs** | Every model has the same fields: release date, pricing (in/out), context window, benchmarks. Currently 3-6 statements per model * 14 models = ~70 statements encoding a 14-row table. | `model_specs(model_id, release_date, input_price, output_price, context_window)` + a `benchmark_scores` table. |
| **Board composition** | Can't answer "who's on Anthropic's board?" at all. Would need person + org + role + start/end. | `board_seats(person_id, org_id, role, start_date, end_date)`. |
| **Ownership stakes** | Google 14% from 2023 — but that's stale. Amazon's stake unknown. No way to track dilution over time. | `equity_stakes(holder_id, org_id, percent, as_of_date)`. |

**Pattern: Statements struggle when data is uniform (every instance has the same fields), relational (connects two entities), or needs temporal state tracking (start/end dates, supersession).**

### The deeper issue: computed queries

Statements store individual facts. But users want *answers*, which often require computation across multiple statements:

| Query | What's needed | Feasible with statements? |
|-------|--------------|--------------------------|
| "What was Anthropic's valuation at each funding round?" | Join funding-round + valuation by date | Fragile — depends on date matching |
| "What % of Anthropic does Amazon own?" | Find equity-stake where holder=Amazon | Sort of — but no guarantee of completeness |
| "Compare Claude 3.5 vs GPT-4o on benchmarks" | Cross-entity, cross-org, same benchmark names | Painful — need matching benchmark property names across orgs |
| "Show all AI labs' revenue on one chart" | Same property across many entities, same units | Works if data is consistent. Statement model is fine here. |
| "Who left Anthropic?" | Need employment records with end_dates | Can't — statements don't track departures |
| "How fast is Anthropic's safety team growing?" | Divide safety-researcher-count by headcount across time | Two separate time series at different granularities. Manual. |
| "Anthropic's funding rounds with lead investors and valuations" | Three-way join: funding-round + valuation + investor entity | Would need 3 statements per event to represent. Fragile. |

## Possible architectures

### Option A: Statements only (current)

Everything stays as statements. Add qualifiers (e.g., `series:E` on both funding-round and valuation) to enable joins. Build computed views that assemble tables from statements.

**Pros**: No new infrastructure, flexible, LLM-friendly
**Cons**: Joins are fragile, schema is implicit, consistency is unenforced, queries require custom logic

**What would need to be built**: Qualifier system, computed view layer, cross-entity query API

### Option B: Tables for structured profiles, statements for everything else

Add 3-5 Postgres tables for the uniform/relational cases: `funding_rounds`, `employment`, `model_specs`, `board_seats`, `equity_stakes`. Statements keep handling narrative facts, policy positions, research findings, etc.

**Pros**: Best of both worlds — structured data gets structure, flexible data stays flexible
**Cons**: Two systems to maintain, need to decide what goes where, migration + API + CLI for each table, potential drift between tables and statements

**What would need to be built**: ~5 tables, API endpoints, CLI commands, possibly admin UI. Define the boundary rule ("if it fits a known profile schema, it goes in a table").

**Per-table cost estimate:**
- Schema + migration: ~1 hour
- API endpoints (CRUD): ~2 hours
- CLI commands: ~1 hour
- Tests: ~1 hour
- Total: ~5 hours per table * 5 tables = ~25 hours
- Plus: documentation, boundary rules, data migration from existing statements

### Option C: Statements as a view layer over tables

Source of truth is either YAML files (for curated data) or Postgres tables (for structured profiles). Statements are *generated* from these for display, search, and LLM consumption. The statement is a denormalized, text-rich representation of a structured fact.

**Pros**: Clean separation of concerns — tables for truth, statements for presentation. No join problems because tables already have the joins.
**Cons**: Complex sync pipeline, statements become derived data (can't edit them directly), need to regenerate on source changes

**What would need to be built**: Table schemas, sync pipeline (tables → statements), possibly bidirectional sync (edit statement → update table). Significant investment.

### Option D: Enhanced entity profiles (structured fields on entities)

Instead of new tables, extend the entity YAML/DB with structured profile fields. An organization entity gets `funding_rounds: [...]`, `board: [...]`, etc. as first-class fields.

**Pros**: No new tables, keeps data close to the entity, works with existing YAML workflow
**Cons**: YAML gets very large, hard to query across entities, mixes schema with data, still need API layer

### Option E: Knowledge graph (triples/quads)

Go full knowledge graph: `(Anthropic, raised, $124M, Series-A-2021)`, `(Series-A-2021, valued-at, $550M)`, `(Series-A-2021, date, 2021-05)`. Each "event" becomes an entity that links to its properties.

**Pros**: Maximum flexibility, natural for relational data, standardized query languages (SPARQL-like)
**Cons**: Steep learning curve, poor UX for simple cases, overkill for time series, LLM-unfriendly for generation

## Key experiments to run

These would inform the architecture decision without requiring us to build anything:

### Experiment 1: The 20-query stress test

Write 20 queries a user would actually ask. For each:
- Try to answer it from current statements
- Rate: clean (works), awkward (works with effort), impossible (can't answer)
- Note what would make it clean (qualifier? table? computed view?)

This produces a concrete failure inventory rather than abstract concerns.

### Experiment 2: Schema stability analysis

For each proposed table (funding_rounds, employment, model_specs, board_seats, equity_stakes):
- List the columns you'd need today
- Predict: what columns will you need in 6 months?
- How stable is this schema?
- How many entities would have data in this table?

If the schema changes frequently or applies to few entities, statements are better. If it's stable and applies to many entities, a table is better.

### Experiment 3: Cross-entity consistency test

Pick one property (e.g., `revenue`) and check it across all entities that have it:
- Are units consistent? (USD? Always annual? ARR vs reported?)
- Are date formats consistent? (month vs year vs quarter?)
- Can you actually plot all AI labs' revenue on one chart from statement data?

This tests whether the statement model's flexibility is actually a bug (inconsistent data) rather than a feature.

### Experiment 4: The "build the table" thought experiment

For funding_rounds specifically, write the full implementation plan:
- Postgres schema
- API endpoints
- CLI commands
- Migration of existing statement data
- What happens to the statements? Delete? Keep as derived?

Then ask: is this actually less work than making statements work with qualifiers? Or is it roughly the same amount of work with a different complexity profile?

### Experiment 5: Second entity cold start

Do the full ontology draft exercise for OpenAI (244 statements, 76% unclassified). See if the same problems emerge. If OpenAI has the same awkwardness around funding rounds and employment, the problem is structural. If it's different, maybe Anthropic is special.

## Decisions log

| # | Decision | Status | Date | Notes |
|---|----------|--------|------|-------|
| 1 | Statement model vs tables for funding rounds | Open | | Need Experiment 1, 4 |
| 2 | Where do model releases live? (parent vs individual entity) | Decided: individual | 2026-03-06 | Each model entity gets its own release-date |
| 3 | RSP version history: Anthropic entity or RSP entity? | Decided: RSP entity (E252) | 2026-03-06 | Anthropic keeps "published RSP" fact only |
| 4 | Property naming convention (-count vs -size) | Open | | Propose standardizing on -count |
| 5 | LTBT board tracking | Open | | Need to decide if this is a statement or a table |
| 6 | Qualifier system for linking related statements | Open | | Could solve funding round join problem |
| 7 | Cross-entity statement references | Open | | Needed for crossEntityUtility improvement |

## What we actually have today (infrastructure inventory)

Understanding the existing pieces before proposing new ones:

### Three data layers, partially overlapping

| Layer | Storage | Schema | Display | Query | Example |
|-------|---------|--------|---------|-------|---------|
| **YAML facts** | `data/facts/anthropic.yaml` | Per-entity YAML with measure, value, asOf, source | `<F e="anthropic" f="valuation-2024">` inline component with hover tooltip | `getFact(entity, factId)` — single lookup | Revenue: $14B |
| **Statements** (Postgres) | wiki-server `statements` table | Flat: entity + property + value + date + text + citations | `StructuredStatementsTable` on entity pages (auto-groups by property, deduplicates) | `GET /api/statements/by-entity` — returns all for an entity | Anthropic raised $124M in Series A |
| **Entity YAML** | `data/entities/*.yaml` | Per-entity with customFields, relatedEntries, sources | `DataInfoBox` sidebar on wiki pages | `getEntityById()` at build time | Type: organization, Founded: 2021 |

**The overlap problem**: Anthropic's valuation appears in all three:
- YAML fact `6796e194`: `value: 380000000000, asOf: 2026-02`
- Statement #11756: `valueNumeric: 380000000000, validStart: "2026-02"`
- Entity YAML customField: (not currently, but could be)

Each layer has different strengths. YAML facts are version-controlled and render inline with `<F>`. Statements have citations, verification, temporal bounds. Entity YAML has relationships and metadata. But there's no clear boundary rule for what goes where.

### How data reaches wiki pages

```
YAML facts ──→ build-data.mjs ──→ database.json ──→ <F e="anthropic" f="revenue">
                                                   ──→ DataInfoBox (top 5 facts in sidebar)
                                                   ──→ <Calc> expressions

Statements ──→ wiki-server API ──→ StructuredStatementsTable (live fetch, entity pages only)
                                 ──→ Claims Explorer (internal dashboard)

Entity YAML ──→ build-data.mjs ──→ database.json ──→ InfoBox, EntityLink, sidebar nav
```

**Key constraint**: Wiki content pages read `database.json` at build time — zero runtime API calls. Statements are only displayed on entity pages via the Statements tab (live API fetch). You can't currently say "show me a table of all Claude model benchmarks" on a wiki page without hardcoding it.

### What `<F>` gives you (Obsidian Dataview-lite)

The `<F>` component is the closest thing to Obsidian's Dataview. In an MDX page you write:

```mdx
Anthropic's valuation reached <F e="anthropic" f="valuation-2024" showDate />
following the Series G round.
```

This renders as an inline value with hover tooltip showing source, date, and metadata. It's simple, composable, and version-controlled. But it's **single-value lookup**, not a query. You can't write "show me all valuations over time" or "compare across entities."

### What `valueSeries` gives you (tables in statements)

The statement schema already has a `valueSeries` field — JSONB, currently used for ranges (`{low: 40, high: 60}`). The test suite shows it accepting arbitrary JSON like `{"2023": 100, "2024": 200}`. This is the "table within a statement" idea — one statement holding a series of values.

**Current usage**: Only for ranges (low/high bounds on estimates). Not used for time series or tabular data.

**Could be extended to**: Store a full funding history as one statement with `valueSeries: {"2021-05": {series: "A", raised: 124e6, valuation: 550e6}, "2022-04": {series: "B", raised: 580e6, valuation: 4e9}, ...}`. One statement instead of 23.

**Tradeoffs**:
- Pro: Solves the join problem — all data is in one place
- Pro: One citation covers the whole series (or could have per-entry citations)
- Con: Loses individual statement granularity (can't retract one funding round without editing the JSON)
- Con: Schema is implicit in the JSON (no type checking, easy to be inconsistent)
- Con: Updates require read-modify-write on the JSON blob

### `qualifierKey` already exists

The statement schema has `qualifierKey: text` with a comment example: `"round:series-g"`. This is exactly the linking mechanism discussed in the Anthropic draft — tag both a funding-round and valuation statement with `round:series-e` to enable joins.

**Current usage**: Zero statements use it. It's defined but never populated.

This could solve the funding-round-valuation join without any new tables. The question is whether it's enough for the harder cases (employment, model specs).

## The nasty corner cases

Ranked by importance and intractability:

### 1. Event-centric data (funding rounds, employment transitions)
**Why it's nasty**: A funding round is ONE event with multiple attributes (amount, valuation, date, series, investors). Statements are entity-property-value triples — they decompose the event into separate rows that must be reassembled. The join key is the date, which is fragile (what if the funding-round says "2025-03" and the valuation says "2025-Q1"?).

**How bad is it today**: 23 statements for 15 funding events. The join works because dates happen to match. But one wrong date and the association breaks silently.

**Possible fixes**:
- **(a) qualifierKey**: Tag both statements with `round:series-e`. Join on qualifier instead of date. Already in schema, zero migration needed. Doesn't solve the "create two statements atomically" problem.
- **(b) valueSeries**: One "funding-history" statement with the full table in JSON. Solves joins completely but loses granularity.
- **(c) Postgres table**: `funding_rounds(entity_id, date, series, amount, valuation, lead_investor)`. Clean, queryable, but separate system to maintain.
- **(d) YAML table**: Add a `funding_rounds:` section to `data/facts/anthropic.yaml` with rows. Render via a new component like `<FundingTable e="anthropic" />`. Version-controlled, reviewable in PRs.

**Recommendation**: (d) is the most natural fit for this project. The YAML facts layer already works, is version-controlled, and has a display component (`<F>`). Extending it to support tabular data (list of rows instead of single values) gives you structured tables without a new database system. Build a `<FactTable e="anthropic" measure="funding-round" />` component that renders rows from YAML.

### 2. Queryable model comparison tables
**Why it's nasty**: Users want to see "all Claude models compared" — release date, pricing, benchmarks, context window. This requires cross-entity queries. Each model is a separate entity with its own statements. There's no "give me property X across entities Y, Z, W" query.

**How bad is it today**: To build a Claude model comparison table, you'd need 14 separate API calls (one per model entity), then manually assemble the results. No component or query exists for this.

**Possible fixes**:
- **(a) Cross-entity statement query**: New API endpoint `GET /api/statements/by-property?propertyId=pricing&entities=claude-3-opus,claude-3-5-sonnet,...`. Returns a table.
- **(b) YAML model specs**: `data/facts/claude-models.yaml` with a table of all models and their specs. One file, one source of truth. Render via `<ModelComparisonTable />`.
- **(c) Hardcoded component**: Like the existing `AnthropicStakeholdersTable.tsx`. Works but doesn't scale.
- **(d) valueSeries on parent**: One statement on `claude` entity with `valueSeries` containing all model specs.

**Recommendation**: (b) again — YAML tabular data. A `claude-models.yaml` file with rows for each model is natural, version-controlled, and easy to render. It's essentially what the entity YAML `customFields` already does, but in table form.

### 3. "Who works at Anthropic now?" (temporal state queries)
**Why it's nasty**: Employment is inherently relational (person ↔ org) and temporal (start/end dates). Statements can capture "Jan Leike joined in May 2024" but can't answer "list everyone currently at Anthropic" because there's no end_date tracking and no departure statements.

**How bad is it today**: Completely broken. Can't query current employees. The 10 position statements tell you about hires but not departures.

**Possible fixes**:
- **(a) YAML roster**: `data/facts/anthropic.yaml` adds a `key_people:` section with `{person, title, start, end}` rows. Departures have an `end` date.
- **(b) Postgres table**: `employment(person_id, org_id, title, start_date, end_date)`.
- **(c) Statement pairs**: "Joined" statement + "Departed" statement. Query requires finding joins without departures. Fragile.

**Recommendation**: (a) for key people (board, C-suite, notable hires — maybe 20-30 per org). A full employee database is out of scope. YAML handles this well and makes departures visible as `end: "2025-03"`.

### 4. Cross-entity consistency (different sources, same fact)
**Why it's nasty**: Anthropic's headcount appears on the Anthropic page, the frontier-ai-comparison page, and in statements. They disagree (4,074 vs ~1,500). Nothing detects this.

**How bad is it today**: We found 3 contradictions in the Anthropic exercise alone. Likely dozens across the wiki.

**Possible fixes**:
- **(a) Single source of truth**: Facts live in YAML only. Wiki pages reference them via `<F>`. No duplication because there's only one place.
- **(b) Automated cross-check**: CI job that compares statement values against YAML facts and flags discrepancies.
- **(c) Accept it**: Contradictions are inevitable in a wiki. Flag them when found, fix them when noticed.

**Recommendation**: (a) is the long-term answer — YAML facts are the source of truth, statements and wiki page prose reference them. (b) is a useful guardrail. (c) is the realistic short-term answer.

### 5. Schema enforcement (is the data complete?)
**Why it's nasty**: A `funding_rounds` table with a NULL valuation column tells you "we know this round happened but don't know the valuation." A missing statement tells you nothing — did we not look, or does the data not exist?

**How bad is it today**: Impossible to distinguish "not entered" from "doesn't exist" from "data is private." The coverage gaps analysis (`crux statements gaps`) gives coarse entity-level scores but can't tell you "Series C is missing a valuation."

**Possible fix**: YAML tabular data naturally solves this — a row with `valuation: null` is explicit. Statements can't represent absence.

## Where this points

The recurring answer to "what fixes the nasty corner cases?" is: **extend the YAML facts layer to support tabular/list data, and build display components for it.**

This is essentially Obsidian Dataview but simpler:
- Data lives in YAML files (version-controlled, human-editable)
- Components render it on wiki pages (`<FactTable>`, `<ModelComparison>`, `<KeyPeople>`)
- Statements remain for narrative claims, policy positions, safety findings — things that don't fit a table
- No new Postgres tables needed (initially)

### What this would look like concretely

**`data/facts/anthropic.yaml` — extended with tables:**
```yaml
entity: anthropic
facts:
  # Existing single-value facts (unchanged)
  6796e194:
    label: "Anthropic post-money valuation"
    value: 380000000000
    asOf: 2026-02
    measure: valuation

tables:
  funding_rounds:
    columns: [date, series, amount_usd, valuation_usd, lead_investor, source]
    rows:
      - [2021-05, "Series A", 124e6, 550e6, "Jaan Tallinn, others", "anthropic.com/news/..."]
      - [2022-04, "Series B", 580e6, 4e9, "Sam Bankman-Fried / FTX", "fortune.com/..."]
      - [2023-05, "Series C", 450e6, 4.1e9, "Google, Salesforce", "fortune.com/..."]
      # ...

  key_people:
    columns: [person_id, title, start, end, source]
    rows:
      - [dario-amodei, "CEO & Co-founder", 2021-01, null, "anthropic.com"]
      - [jan-leike, "Head of Alignment Science", 2024-05, null, "anthropic.com"]
      - [mike-krieger, "Chief Product Officer", 2024-05, 2025-08, "techcrunch.com"]
      # ...
```

**MDX page usage:**
```mdx
## Funding History

<FactTable e="anthropic" table="funding_rounds" />

## Leadership

<KeyPeople e="anthropic" table="key_people" />
```

**`data/facts/claude-models.yaml` — model comparison:**
```yaml
entity: claude
tables:
  model_specs:
    columns: [model_id, release_date, input_price, output_price, context_window, swe_bench, arc_agi_2]
    rows:
      - [claude-3-opus, 2024-03-04, 15, 75, 200000, null, null]
      - [claude-3-5-sonnet, 2024-06-20, 3, 15, 200000, 49.0, null]
      - [claude-opus-4-6, 2026-02-05, 5, 25, 200000, null, 68.8]
      # ...
```

### Advantages of this approach

1. **Version-controlled**: PRs show diffs of data changes. "Added Series G row" is one line in a YAML diff.
2. **LLM-curated**: An LLM agent can read sources and propose new rows. Human reviews the YAML diff.
3. **No migrations**: Adding a column to a YAML table is editing a file, not a database migration.
4. **Renders anywhere**: `<FactTable>` works in any MDX page. Cross-entity tables work by referencing multiple entities.
5. **Completeness visible**: A row with `null` in the valuation column is explicit. Missing rows can be detected by expected-vs-actual date ranges.
6. **Coexists with statements**: Statements keep doing what they're good at (narrative claims). Tables handle structured profiles. Clear boundary.

### What statements would still do

- Policy positions ("Anthropic endorsed SB 53")
- Safety incidents ("CVE-2025-54794 prompt injection flaw")
- Research findings ("Sleeper Agents paper demonstrated...")
- Qualitative claims ("Dario Amodei stated 25% p(doom)")
- Comparative observations ("Anthropic has 42% enterprise coding market share")
- Any fact where the schema is uncertain or the content is narrative-rich

### What YAML tables would handle

- Funding rounds (uniform schema, relational to investors)
- Key people/employment (person ↔ org ↔ title ↔ dates)
- Model specs (uniform across all models)
- Board composition (person ↔ role ↔ dates)
- Benchmark scores (model ↔ benchmark ↔ score)
- Equity stakes (holder ↔ org ↔ percent ↔ date)

## Open questions

1. **How many entity types actually need structured profiles?** If it's only 3 (organizations, people, AI models), maybe 3 tables is fine. If it's 15, the table approach doesn't scale and we need a more general solution.

2. **Who's the user?** If it's researchers querying an API, tables are better. If it's an LLM consuming context to write wiki pages, statements are better. If it's humans browsing the website, the display layer matters more than the storage layer.

3. **What's the update cadence?** Funding rounds happen a few times per year — manual curation is fine. Benchmark scores update with every model release — needs more automation. Revenue updates monthly — somewhere in between.

4. **Do we need historical accuracy or current state?** Statements with `validStart`/`validEnd` track history naturally. Tables with `start_date`/`end_date` can too, but it's more complex (slowly changing dimensions). If we only care about "what's true now," tables are simpler.

5. **What's the cost of being wrong?** If we build tables and they're wrong, we have dead schema and migration debt. If we extend statements and they're wrong, we have a more complex statement model that's hard to simplify. Which is easier to reverse?

6. **YAML tables vs Postgres tables?** YAML is version-controlled and human-editable but not queryable at scale. Postgres is queryable but requires migrations and API endpoints. For the wiki's scale (~70 entities with structured profiles, ~500 rows total across all tables), YAML is likely sufficient. Postgres becomes necessary at ~10K+ rows or when you need complex queries.

7. **How do YAML tables relate to existing statements?** Options: (a) Replace statements for structured data — retract the individual statements, YAML table is source of truth. (b) Both exist — YAML for display, statements for citations/verification. (c) Generate statements from YAML — YAML is source, statements are derived. Recommend (a) initially — simpler, avoids drift.

## Design: YAML Structured Tables

### Framing

The wiki is a delivery mechanism. The real product is a **structured knowledge base about AI safety** — organizations, people, models, funding, governance, research. Some of that knowledge is naturally tabular (funding rounds, employment, model specs). Some is naturally narrative (policy positions, safety findings, research conclusions). The system should handle both without forcing everything into one mold.

This section designs the tabular layer in detail, enough to red-team on paper.

### Schema format

Each entity can have structured tables alongside its existing single-value facts:

```yaml
# data/facts/anthropic.yaml
entity: anthropic

facts:
  # Existing single-value facts (unchanged)
  6796e194:
    label: "Anthropic post-money valuation"
    value: 380000000000
    asOf: 2026-02
    measure: valuation

tables:
  funding_rounds:
    description: "Equity and strategic investment rounds"
    schema:
      date: { type: date, required: true }
      series: { type: string }  # "Series A", "Amazon strategic", etc.
      amount: { type: currency, unit: USD }
      valuation: { type: currency, unit: USD }
      lead_investor: { type: entity_ref }  # references entity IDs where possible
      source_url: { type: url }
      notes: { type: string }
    rows:
      - date: 2021-05
        series: "Series A"
        amount: 124e6
        valuation: 550e6
        lead_investor: null  # no entity for Jaan Tallinn yet
        source_url: "https://www.anthropic.com/news/anthropic-raises-124-million"
      - date: 2022-04
        series: "Series B"
        amount: 580e6
        valuation: 4e9
        lead_investor: ftx
        source_url: "https://fortune.com/2023/05/23/anthropic-series-c-fundraise/"
        notes: "FTX was lead; stake later sold by FTX estate for ~$1.4B"
      - date: 2023-05
        series: "Series C"
        amount: 450e6
        valuation: 4.1e9
        lead_investor: null  # Google + Salesforce co-led
        source_url: "https://fortune.com/2023/05/23/anthropic-series-c-fundraise/"
      # ... more rows

  key_people:
    description: "Current and former key personnel"
    schema:
      person: { type: entity_ref, required: true }
      title: { type: string, required: true }
      start: { type: date }
      end: { type: date }  # null = current
      is_founder: { type: boolean, default: false }
      source_url: { type: url }
    rows:
      - person: dario-amodei
        title: "CEO"
        start: 2021-01
        is_founder: true
      - person: jan-leike
        title: "Head of Alignment Science"
        start: 2024-05
        source_url: "https://www.anthropic.com/news/jan-leike-joins-anthropic"
      - person: mike-krieger
        title: "Chief Product Officer"
        start: 2024-05
        end: 2025-08
        notes: "Moved to head of Anthropic Labs"

  equity_stakes:
    description: "Known ownership positions"
    schema:
      holder: { type: entity_ref, required: true }
      percent: { type: number }  # null = undisclosed
      as_of: { type: date, required: true }
      source_url: { type: url }
      notes: { type: string }
    rows:
      - holder: google  # entity ref to google/deepmind entity
        percent: 14
        as_of: 2023-10
        notes: "Likely diluted significantly since this date"
      - holder: null  # co-founders (no single entity)
        percent: 17.5
        as_of: 2026-02
        notes: "7 co-founders at ~2.5% each"
```

### Design decisions baked into this format

**1. Named columns with types, not positional arrays.**

Earlier sketch used `columns: [date, series, amount]` with `rows: [[2021-05, "A", 124e6]]`. This is compact but fragile — column order matters, nulls are ambiguous, no type info. Named-field rows are more verbose but self-documenting and safe to reorder.

**2. `entity_ref` type for relational data.**

When a field references another entity (a person, an investor), it uses the entity's string ID. This enables:
- Validation: does this entity exist?
- Display: render as an EntityLink with hover card
- Queries: "find all tables where entity X appears as a value"

But it means entities must exist before they can be referenced. The "FK dance" from the statement system returns here.

**3. Schema lives in the YAML, not in a central registry.**

Each table defines its own schema inline. This means:
- Two entities can have `funding_rounds` tables with different columns
- No global "funding_rounds schema" to maintain
- But also: no guarantee that Anthropic's funding table and OpenAI's funding table have the same structure

This is a deliberate tradeoff. Rigid global schemas (like Postgres tables) guarantee consistency but require migrations. Inline schemas are flexible but can drift.

**4. `source_url` per row, not per table.**

Different rows may come from different sources. A Series A fact comes from Anthropic's blog; a Series G fact comes from Reuters. Row-level sources are necessary.

**5. `notes` for things that don't fit the schema.**

"FTX was lead; stake later sold for ~$1.4B" doesn't fit any column. Rather than adding columns for every edge case, a free-text notes field handles the long tail. This is where the statement model's flexibility lives within the table model.

### Cross-entity tables

Some tables span multiple entities. Model comparisons are the obvious case:

```yaml
# data/facts/claude-models.yaml (or data/tables/model-specs.yaml)
# This file is NOT per-entity — it's a cross-entity table
cross_entity: true
description: "Claude model family specifications"

tables:
  model_specs:
    schema:
      model: { type: entity_ref, required: true }
      release_date: { type: date, required: true }
      input_price: { type: number, unit: "USD/MTok" }
      output_price: { type: number, unit: "USD/MTok" }
      context_window: { type: number, unit: tokens }
      swe_bench: { type: number, unit: percent }
      arc_agi_2: { type: number, unit: percent }
      mmlu: { type: number, unit: percent }
      asl_level: { type: string }  # "ASL-2", "ASL-3"
    rows:
      - model: claude-3-opus
        release_date: 2024-03-04
        input_price: 15
        output_price: 75
        context_window: 200000
        swe_bench: null
        mmlu: 86.8
        asl_level: "ASL-2"
      - model: claude-3-5-sonnet
        release_date: 2024-06-20
        input_price: 3
        output_price: 15
        context_window: 200000
        swe_bench: 49.0
        mmlu: 88.7
        asl_level: "ASL-2"
      - model: claude-opus-4-6
        release_date: 2026-02-05
        input_price: 5
        output_price: 25
        context_window: 200000
        swe_bench: null
        arc_agi_2: 68.8
        asl_level: "ASL-2"
```

**Open design question**: Should cross-entity tables live in `data/facts/` or in a new `data/tables/` directory? Arguments:
- `data/facts/`: Keeps all structured data together. Build pipeline already reads this directory.
- `data/tables/`: Cleaner separation. Entity-scoped facts vs. cross-entity tables are conceptually different.

### Display components

```mdx
{/* On the Anthropic wiki page */}

## Funding History
<FactTable e="anthropic" table="funding_rounds" />

## Key People
<FactTable e="anthropic" table="key_people"
  filter="end is null"    {/* only current employees */}
  sort="start desc" />

## Ownership
<FactTable e="anthropic" table="equity_stakes" />

{/* On a comparison page */}

## Claude Model Family
<FactTable file="claude-models" table="model_specs"
  sort="release_date desc" />
```

`<FactTable>` is a server component that:
1. Reads the YAML table from `database.json` (loaded at build time)
2. Applies optional filter/sort
3. Renders a responsive table with:
   - Entity refs as `<EntityLink>` components
   - Currency values formatted ($124M, $4B)
   - Dates formatted consistently
   - Null values shown as "—"
   - Source URLs as clickable icons
   - Notes as hover tooltips

No runtime API calls. Everything resolved at build time from `database.json`.

### Build pipeline changes

```
data/facts/*.yaml ──→ build-data.mjs ──→ database.json
  (now includes       (new: parse         (new: tables
   tables: {} )        table schemas,       section with
                       validate refs,       typed rows)
                       format values)
```

`build-data.mjs` changes:
1. Parse `tables:` sections from fact YAML files
2. Validate `entity_ref` fields against known entities
3. Validate types (dates are valid, numbers are numbers)
4. Include tables in `database.json` for build-time consumption
5. Report validation errors (missing entity refs, type mismatches)

### Update workflow

```
LLM finds new fact ──→ proposes YAML edit ──→ PR with diff ──→ human reviews ──→ merge
                        (e.g., new funding       visible in         approve/reject
                         round row)              GitHub UI          individual rows
```

This is the same workflow as content changes today. The key advantage: a PR diff shows exactly what data changed:

```diff
  rows:
    - date: 2025-07
      series: "Series F"
      amount: 13e9
      valuation: 183e9
+   - date: 2026-02
+     series: "Series G"
+     amount: 30e9
+     valuation: 380e9
+     source_url: "https://reuters.com/..."
```

Compare this to the current statement workflow: "POST a new statement to the API, hope the property and value are right, check the website to verify." The YAML approach makes the change reviewable before it's applied.

### Red-team: what could go wrong

#### 1. Schema drift across entities

**Risk**: Anthropic's `funding_rounds` has `lead_investor` but OpenAI's version has `investors` (plural, array). A comparison query across both entities breaks.

**Severity**: Medium. Cross-entity queries need consistent schemas.

**Mitigations**:
- (a) **Table type templates**: Define standard schemas in `data/table-schemas/` for common table types. Entity tables reference them. Validation enforces conformance. This is the "migration" cost of YAML tables — but it's a YAML edit, not a SQL migration.
- (b) **Validation in build-data**: Flag when two entities have tables with the same name but different schemas.
- (c) **Accept it**: For the first few entities, schema differences are manageable. Standardize later once patterns stabilize.

#### 2. YAML files get huge

**Risk**: If Anthropic has 6 tables with 20 rows each, plus 30 single-value facts, the YAML file is 500+ lines. OpenAI might be bigger.

**Severity**: Low-medium. Readable but unwieldy.

**Mitigations**:
- Split into multiple files: `data/facts/anthropic/funding.yaml`, `data/facts/anthropic/people.yaml`
- Or: move tables to `data/tables/anthropic-funding-rounds.yaml`
- build-data already handles multiple files per entity (just needs glob pattern)

#### 3. Entity refs create tight coupling

**Risk**: `lead_investor: ftx` requires an `ftx` entity to exist. If someone deletes or renames the entity, the YAML breaks. Same "FK dance" as statements.

**Severity**: Medium. Especially bad during initial data entry when many entities don't exist yet.

**Mitigations**:
- (a) **Soft refs**: Allow string values that aren't entity IDs. Display as plain text instead of EntityLink. Upgrade to entity_ref when the entity exists.
- (b) **Auto-create**: Build-data creates minimal entities for unknown refs (like it does for MDX frontmatter `entityType`).
- (c) **Validation warning, not error**: Flag unresolved refs but don't block the build.

Recommend (a) + (c): soft refs with validation warnings. Don't block data entry on entity existence.

#### 4. No runtime queries

**Risk**: Everything is build-time. You can't ask "which entities have funding tables?" at runtime. API consumers can't query tables. The Claims Explorer dashboard can't show table data.

**Severity**: Medium-high if the knowledge base is the real product (not just the wiki).

**Mitigations**:
- (a) **Build-time is fine initially**: The wiki is the primary consumer. Runtime queries can come later.
- (b) **Sync YAML → Postgres**: Build-data can also write table data to the wiki-server DB. YAML stays source of truth; DB is a queryable mirror. This is Option C from earlier (statements as derived).
- (c) **API endpoint for database.json tables**: A simple `GET /api/tables/:entity/:tableName` that serves the build-time JSON. Read-only, no write path.

#### 5. Duplicate data with existing statements

**Risk**: We have 23 funding-round/valuation statements AND a YAML funding table. Which is the source of truth? They diverge.

**Severity**: High. This is the #1 operational risk.

**Mitigations**:
- (a) **Retract statements when YAML table exists**: Clear rule — if a YAML table covers a data domain, the corresponding statements are retracted. The YAML table is authoritative.
- (b) **Generate statements from YAML**: The YAML table is source of truth. build-data (or a separate sync) generates statements from table rows. Statements become a derived/cached representation.
- (c) **Both exist, different purposes**: YAML tables for structured display on wiki pages. Statements for citation tracking and LLM consumption. Accept the duplication as serving different needs.

Recommend (a) for the initial experiment. If it works, consider (b) for automation.

#### 6. Who curates the YAML?

**Risk**: The current statement workflow is "LLM extracts facts from sources, creates statements via API." Shifting to YAML means the LLM must produce YAML edits instead. This changes the tooling: `crux statements create` → `crux tables add-row`.

**Severity**: Low. LLMs are good at YAML. The review step (PR diff) is actually better than the current flow (inspect API response on prod).

**Workflow change**:
```
Before: LLM → API POST → statement in DB → visible on website
After:  LLM → edit YAML → git commit → PR → human review → merge → build → visible on website
```

The "after" workflow has more steps but each step is reviewable. The "before" workflow is faster but mistakes go directly to prod.

#### 7. Losing statement features (citations, verification, temporal bounds)

**Risk**: Statements have rich metadata — citations with source quotes, LLM verification verdicts, temporal granularity. YAML table rows have `source_url` and `notes`. We lose citation tracking, verification status, and the temporal supersession model.

**Severity**: Medium. For structured data (funding rounds, model specs), this might be acceptable — the data is simple and verifiable. For more nuanced claims, it's a real loss.

**Mitigations**:
- (a) **Add citation fields to YAML rows**: `source_url`, `source_quote`, `verified: true/false`. Increases verbosity but preserves provenance.
- (b) **Accept the tradeoff**: YAML tables handle well-structured, easily-verifiable data. Leave complex citation tracking to statements for narrative claims.
- (c) **Hybrid rows**: YAML row can optionally reference a statement ID for its full citation chain. The row is the "truth" for the value; the statement provides the citation metadata.

#### 8. No history / audit trail

**Risk**: YAML tables show current state. If you change a valuation from $350B to $380B, the old value is only in git history. Statements have `validEnd` for explicit supersession.

**Severity**: Low for most tables (funding rounds don't change — you add new rows). Medium for mutable fields (equity stakes, employee titles).

**Mitigations**:
- Git history IS the audit trail. `git log -p data/facts/anthropic.yaml` shows every change with timestamps and commit messages.
- For fields that change over time (equity stakes), the table already has `as_of` dates — multiple rows for the same holder at different dates.

#### 9. What if this doesn't scale beyond 5 entities?

**Risk**: YAML tables work great for Anthropic, OpenAI, DeepMind. Then you try to do it for 70+ entities and the curation effort is unsustainable.

**Severity**: High. This is the fundamental scalability question.

**Mitigations**:
- (a) **Not all entities need tables**: Only frontier labs, major people, and AI models need structured profiles. The long tail of policy responses, risk concepts, and research topics stay as statements/wiki prose.
- (b) **LLM auto-population**: Once the schema is defined, an LLM can read wiki pages and existing statements to auto-populate tables. Human reviews the batch.
- (c) **Tiered effort**: Tier 1 entities (Anthropic, OpenAI, DeepMind) get full manual curation. Tier 2 (20 major orgs) get LLM-populated tables. Tier 3 (everything else) stays as-is.

#### 10. "We need an actual database"

**Risk**: After building YAML tables for 10 entities with 5 table types each, we realize we need: filtering, sorting, aggregation, joins across tables, API access, user-facing search. YAML can't do this. We rebuild everything in Postgres anyway.

**Severity**: High. This is the "did we build the wrong thing?" risk.

**Mitigations**:
- (a) **YAML → Postgres sync from day 1**: Even if YAML is the source of truth, mirror it to Postgres via build-data. Then runtime queries work.
- (b) **Design the YAML format to be Postgres-compatible**: Column types map to SQL types. Entity refs map to foreign keys. The migration path is mechanical if we need it.
- (c) **Set a trigger**: "If we have >10 table types or >1000 rows, re-evaluate whether YAML is still the right storage layer."

### Comparison: YAML tables vs. Postgres tables vs. enhanced statements

For each nasty corner case, which approach handles it best?

| Corner case | YAML tables | Postgres tables | Enhanced statements (qualifiers) |
|-------------|:-----------:|:---------------:|:--------------------------------:|
| Funding round + valuation join | **Clean** — one row per event | **Clean** — one row per event | Fragile — qualifierKey join |
| "Who works at Anthropic now?" | **Clean** — filter `end is null` | **Clean** — WHERE end IS NULL | Can't — no departure tracking |
| Model comparison across entities | **Clean** — cross-entity table | **Clean** — SQL query | Painful — 14 API calls + merge |
| Schema enforcement | Inline schema, build-time validation | SQL constraints, compile-time | None — implicit schema |
| Missing data visibility | Null in column = explicit gap | Null in column = explicit gap | Missing statement = invisible |
| Version control / review | **Best** — git diff, PR review | Needs audit log | API calls, no review step |
| Runtime queries | Needs build + optional sync | **Best** — SQL | **Best** — API exists |
| Citation tracking | source_url per row | Needs citation table | **Best** — native |
| LLM consumption | Good — YAML is readable | Needs API/export | **Best** — text + metadata |
| Schema changes | Edit YAML, no migration | SQL migration + deploy | No schema to change |
| Scale (>1000 entities) | Unwieldy | **Best** | **Best** — designed for scale |

**Summary**: YAML tables win on reviewability and simplicity at current scale. Postgres wins on queryability and scale. Statements win on flexibility and citation tracking. The project is at a scale where YAML tables are likely sufficient, with a clear migration path to Postgres if needed.

### Reframing: it's about schemas and IDs, not storage format

The previous analysis framed this as "YAML tables vs Postgres tables vs statements." But the user's insight is sharper: **the core issue is whether data has a clear schema and stable IDs that can reference each other.** If it does, you get relational capabilities regardless of where the data lives.

Consider:

```
# Current statement (semi-structured)
{subjectEntityId: "anthropic", propertyId: "funding-round", valueNumeric: 124e6, validStart: "2021-05"}

# Ken Standard fact (structured triple)
{subjectId: "anthropic/funding/series-a", propertyId: "stdlib/amount", value: 124000000}

# YAML fact (what we already have)
series-a: { measure: funding-round, value: 124e6, asOf: 2021-05 }
```

These are all expressing the same thing. The differences are:
1. **ID granularity**: Statements identify the entity (`anthropic`) but not the specific sub-item (`series-a`). Ken identifies the sub-item. YAML facts use a hash ID.
2. **Schema**: Statements have an implicit schema (propertyId determines what valueNumeric means). Ken relies on property definitions in a stdlib. YAML facts use `measure` definitions.
3. **Relationships**: Statements use `valueEntityId` to reference other entities. Ken uses IDs in values. YAML uses entity slugs.

The Ken Standard's key insight: **subjects can be sub-items** (`anthropic/funding/series-a`), not just top-level entities. This means a funding round IS an entity (with its own facts: amount, valuation, date, lead investor), not just a property of Anthropic.

#### What this means for our design

Instead of thinking "should we store funding rounds as YAML tables or Postgres rows?", think: **should a funding round be an entity (with its own ID and facts) or a property of an organization entity?**

Currently: funding round = a property of Anthropic (statement with `propertyId: "funding-round"`)
Ken-like: funding round = its own subject (`anthropic/funding/series-a`) with properties (`amount`, `valuation`, `date`, `lead-investor`)

The Ken approach solves the join problem naturally: a funding round's amount and valuation are properties of the SAME subject, not separate statements on different subjects that must be joined by date.

#### How this maps to our existing infrastructure

We already have most of this:
- **Entities** = Ken subjects. We have entity IDs (`anthropic`, `claude-opus-4-6`).
- **Facts** = Ken facts. We have `data/facts/anthropic.yaml` with key-value pairs.
- **Measures** = Ken properties. We have `data/fact-measures.yaml` defining property types.
- **Entity refs** = Ken ID references. We have `relatedEntries` in entity YAML.

What we're missing:
- **Sub-item entities**: A funding round isn't an entity. It should be. Same for employment records, board seats, model releases.
- **Schema enforcement**: No validation that "a funding-round entity must have amount, date, series." fact-measures.yaml defines properties but doesn't define required properties per entity type.
- **Entity type schemas**: "An organization entity should have these tables/properties" — this doesn't exist.

#### The "just use schemas" approach

Rather than building a new table system, extend what exists:

1. **Create entities for sub-items**: `anthropic-series-a` (type: `funding-round`), `anthropic-series-b`, etc. Each gets facts: `amount`, `valuation`, `date`, `lead-investor`.
2. **Define entity type schemas**: "A `funding-round` entity must have: amount (currency), date (date), series (string). Should have: valuation (currency), lead-investor (entity-ref)."
3. **Render via queries**: `<FactTable entityType="funding-round" parent="anthropic" />` queries all funding-round entities related to Anthropic, shows their facts as columns.

**Pros**:
- No new infrastructure — uses existing entities + facts
- Each sub-item has a proper ID and can be referenced
- Schema validation is just a YAML file defining required facts per entity type
- The entity system already handles relationships (`relatedEntries`)

**Cons**:
- Entity explosion: 15 funding rounds * 5 orgs = 75 new entities just for funding
- YAML file management: where do these mini-entities live?
- Overhead: creating an entity with ID allocation, YAML entry, facts file — heavy for "Series A raised $124M"
- Currently entity creation requires `crux ids allocate` — not designed for bulk sub-items

**Assessment**: This is conceptually clean but operationally heavy. Creating 75 entities for funding rounds feels like using a sledgehammer. The Ken Standard handles this gracefully because entities are lightweight (just a section header in a TOML file). Our entities are heavyweight (YAML entry, numeric ID, build-data processing, potential wiki page).

#### The middle ground: lightweight sub-entities

What if sub-items were a lighter-weight concept than full entities?

```yaml
# data/facts/anthropic.yaml
entity: anthropic

facts:
  # ... existing single-value facts

items:
  funding-rounds:
    type: funding-round  # references a schema in data/schemas/
    entries:
      series-a:
        date: 2021-05
        amount: 124e6
        valuation: 550e6
        source: "https://anthropic.com/news/..."
      series-b:
        date: 2022-04
        amount: 580e6
        valuation: 4e9
        lead_investor: ftx
        source: "https://fortune.com/..."
        notes: "FTX estate later sold stake for ~$1.4B"
```

These `items` are:
- Keyed by a local ID (`series-a`) — stable within the entity, not globally unique
- Typed (`funding-round`) — schema defines expected fields
- Lightweight — no numeric ID allocation, no entity YAML entry
- Referenceable — `anthropic/funding-rounds/series-a` as a path
- Renderable — `<ItemTable e="anthropic" items="funding-rounds" />`

This is basically the Ken Standard pattern adapted to our YAML facts structure. Sub-items within an entity, each with their own key and typed fields.

### Side-by-side: Ken Standard vs. our system vs. what we're missing

Having read the Ken source (ReasonML core, TOML data files, property definitions, FHI/people examples), here's the concrete mapping:

#### Core data model

| Concept | Ken Standard | Our system | Gap |
|---------|-------------|------------|-----|
| **Entity** | "Thing" — any subject with an ID | Entity — YAML entry with `id`, `numericId`, `type` | Ken's Things are lightweight (TOML section header). Ours are heavyweight (YAML entry, numeric ID allocation, build pipeline). |
| **Fact** | `{subjectId, propertyId, value, factId}` — a triple with its own ID | YAML fact: `{measure, value, asOf, source}` keyed by hash. Statement: `{subjectEntityId, propertyId, valueNumeric, ...}` | We have TWO fact systems (YAML facts + Postgres statements) that overlap. Ken has one. |
| **Property** | TOML section in `properties.toml` — self-describing (name, data-type, inverse-name) | YAML entry in `fact-measures.yaml` — similar (label, unit, category, display) | Very similar. Ken has `inverse-name` (e.g., "Employed By" ↔ "Employs") which we lack. |
| **Value type** | `String(string) \| ThingId(string) \| JSON(json)` — three variants | `valueNumeric \| valueText \| valueEntityId \| valueDate \| valueSeries` — five+ variants | Ken is simpler. Most values are either strings or references to other Things. |
| **Base** | Container for related Things/Facts. Has a `baseId`. Composable — bases reference each other via `@baseId/...` | No direct equivalent. Closest: entity YAML files group entities by type (`organizations.yaml`, `people.yaml`). | Ken's bases are a namespace/composition mechanism. We don't have this — all entities share one flat namespace. |
| **ID system** | Hierarchical: `@people/d/h-anders-sandberg`, `@fhi/_f/AxXzJWsuXVbY` | Flat slugs: `anders-sandberg`, `anthropic`. Numeric IDs: `E22`. | Ken's IDs encode hierarchy (base + resource + thing). Ours are flat. Ken can express "fact about a thing" as `thing/_f/factId`. |

#### How Ken handles relational data (the FHI example)

The FHI TOML file shows exactly how Ken does the "who works here?" query:

```toml
[n-fhi]
name = "The Future of Humanity Institute"
instance-of = "n-organization"
"\employed-by" = [
    "@people/d/h-nick-bostrom",
    "@people/d/h-anders-sandberg",
    "@people/d/h-toby-ord",
    ...
]
```

Key observations:
1. **Inverse properties**: `"\employed-by"` on the org is the inverse of `employed-by` on the person. The `\` prefix means "this property is defined in reverse." Anders Sandberg has `Employed By: FHI`, and FHI has `\Employed By: [list of people]`. Same relationship, two directions.
2. **Array values**: Multiple employees are just an array. No separate "employment" entity needed for the simple case.
3. **Cross-base references**: People are in the `@people` base, FHI is in the `@fhi` base. The `@` prefix handles cross-base linking.
4. **Sub-organizations**: FHI Leadership, Macrostrategy Research Team — these are separate Things with `parent-organization: "n-fhi"`. Hierarchy via properties, not via nested data structures.

**What Ken DOESN'T do**: temporal state. There's no `start-date`, `end-date` on Anders Sandberg's employment. If he left FHI, you'd... remove him from the list? There's no history. Ken is for **current state knowledge graphs**, not temporal fact databases.

This is a critical difference from our system. We care about "Anthropic's revenue in Q3 2025" and "who left Anthropic in 2024?" Ken doesn't model time.

#### Where we're already aligned

| Feature | Ken | Us | Status |
|---------|-----|-----|--------|
| Entities as typed things | `instance-of = "n-organization"` | `type: organization` | **Aligned** |
| Properties defined centrally | `properties.toml` | `fact-measures.yaml` | **Aligned** |
| Entity refs in values | `ThingId("@people/d/h-nick-bostrom")` | `valueEntityId: "nick-bostrom"` | **Aligned** (different syntax) |
| Self-describing properties | `p-name`, `p-description`, `p-data-type` | `label`, `description`, `unit`, `category` | **Aligned** |
| Facts have own IDs | `@fhi/_f/AxXzJWsuXVbY` | Hash keys `6796e194` in YAML, numeric IDs in statements | **Aligned** |
| Flat file storage | TOML files | YAML files | **Aligned** (different format) |
| Composable namespaces | Bases with `@base/` references | None | **Gap** |
| Inverse properties | `p-inverse-name = "Employs"` | None | **Gap** |
| Temporal data | None | `asOf`, `validStart`, `validEnd` | **We're ahead** |
| Citations/provenance | None (just fact IDs) | `source`, `sourceResource`, citations array | **We're ahead** |
| Verification | None | `verdict`, `verdictScore`, `verdictModel` | **We're ahead** |
| Display formatting | None (Explorer renders raw) | `display: {divisor, prefix, suffix}` | **We're ahead** |

#### Where we diverge and what it means

**1. Two fact systems vs. one**

Ken has one fact model: `(subject, property, value)`. We have:
- YAML facts: `data/facts/anthropic.yaml` — version-controlled, used by `<F>` component
- Postgres statements: wiki-server `statements` table — API-served, used by Statements tab

These overlap (Anthropic's valuation exists in both). Ken would say: pick one.

**Our situation is actually worse than Ken's**: we don't just have two stores, we have two stores with DIFFERENT capabilities. YAML facts have no citations or verification. Statements have no version control or PR review. Neither is clearly superior.

**2. Heavyweight entities vs. lightweight things**

Creating a Ken Thing: add a `[section-header]` to a TOML file. Done.
Creating our entity: `pnpm crux ids allocate <slug>`, add to `data/entities/*.yaml` with `numericId`, `type`, `relatedEntries`, build-data processes it.

This matters for the "sub-item" question. Should a funding round be an entity? In Ken, yes — it's just a section header. In our system, it's a heavyweight operation. This is why the "items" proposal felt necessary — we need something lighter than entities for sub-items.

**3. No inverse properties**

Ken defines `Employed By` with inverse `Employs`. When Anders Sandberg has `employed-by = FHI`, the Explorer can also show FHI with `Employs: [Anders Sandberg, ...]` without storing it twice.

We don't have this. `relatedEntries` on the Anthropic entity lists Dario Amodei, and `relatedEntries` on Dario lists Anthropic. It's manually duplicated in both YAML files. If one changes, the other doesn't.

This is a solvable problem — build-data could compute inverse relationships — but we haven't done it for facts/statements.

**4. No namespace/composition**

Ken's base system lets you say "the FHI base references people from the people base via `@people/d/...`". This is how distributed knowledge graphs compose.

We have one flat namespace. All entity IDs are globally unique. This works at our scale (~550 entities) but doesn't compose — you can't take someone else's data and merge it.

Not urgent, but worth noting as a long-term architectural difference.

#### Minimal changes to get Ken-like capabilities

If the goal is "structured data with schemas and IDs that can reference each other, stored in flat files, renderable on wiki pages" — what's the minimal path?

**Change 1: Unify on one fact system** (high impact, medium effort)

Decide: YAML facts are the source of truth for structured data. Statements are either (a) derived from YAML for API consumers, or (b) reserved for narrative claims only.

This eliminates the dual-store problem. Version-controlled YAML with PR review is the curation workflow. The API serves it read-only.

**Change 2: Add lightweight sub-items to YAML facts** (high impact, medium effort)

Extend `data/facts/anthropic.yaml` to support keyed items with typed fields:

```yaml
items:
  funding-rounds:
    type: funding-round
    entries:
      series-a: { date: 2021-05, amount: 124e6, valuation: 550e6 }
      series-b: { date: 2022-04, amount: 580e6, valuation: 4e9, investor: ftx }
```

Each entry gets a stable local ID (`series-a`) and typed fields. This is the Ken-like "lightweight thing" without full entity overhead.

**Change 3: Define entity-type schemas** (medium impact, low effort)

A new YAML file defining what properties each entity type should have:

```yaml
# data/schemas/organization.yaml
required:
  - founded-date
  - headquarters
  - headcount
recommended:
  - revenue
  - valuation
  - funding-rounds  # item type
  - key-people      # item type
```

build-data validates entities against their type schema and reports gaps. This is schema enforcement without Postgres constraints.

**Change 4: Compute inverse relationships** (medium impact, low effort)

In build-data, when entity A has `relatedEntries: [{id: B}]`, automatically add A to B's related entries. Same for facts: if a fact has `valueEntityId: "openai"`, the OpenAI entity knows about it.

This gives us Ken's inverse properties without explicit `p-inverse-name` declarations.

**Change 5: Build `<FactTable>` / `<ItemTable>` component** (high impact, medium effort)

A server component that reads items from database.json and renders a table. This is the display layer for Change 2.

```mdx
<ItemTable e="anthropic" items="funding-rounds" />
```

**What we deliberately DON'T do:**
- No namespace/composition system (not needed at our scale)
- No TOML migration (YAML works fine)
- No new Postgres tables (YAML is sufficient initially)
- No graph query language (build-time rendering is enough)

#### The temporal question Ken doesn't answer

Ken stores current state. Our system needs history. This is the real design tension:

- **YAML facts**: Have `asOf` dates but no `validEnd`. Can store time series via multiple facts with different `asOf` values. History is in git.
- **Statements**: Have `validStart` and `validEnd`. Designed for temporal tracking. History is in the DB.
- **YAML items**: Would need `as_of` or `date` fields per entry. For time-series data (revenue), each entry is a point in time. For state data (employment), entries need start/end dates.

For the funding-rounds case, time is simple: each entry has a `date` field and they don't supersede each other. For employment, it's harder: an entry with `end: null` means "current," and when someone leaves, you set `end: 2025-08`. Git history captures when you made that change, but the YAML itself shows the current state.

This is adequate for our needs. The full temporal database (slowly changing dimensions, bitemporal tracking) is overkill for a knowledge base with manual curation.

### Proposed experiment sequence

1. **Anthropic funding rounds** — the clearest table-shaped data. 15 rows, well-understood schema. Tests: YAML format, build pipeline, FactTable component, PR review workflow.

2. **Claude model specs** — cross-entity table. 14 rows. Tests: entity_ref validation, cross-entity display, comparison rendering.

3. **Anthropic key people** — relational (person ↔ org). Tests: entity_ref to people, start/end date handling, departure tracking.

4. **OpenAI funding rounds** — second entity, same table type. Tests: schema consistency across entities, template reuse.

5. **Evaluate**: After 4 experiments, do we have enough signal? Are YAML tables working? Do we need Postgres? What's broken?

### What to flag as experimental

- `data/tables/` directory (or `tables:` sections in `data/facts/`)
- `<FactTable>` component
- build-data table parsing
- Any CLI commands for table management
- Mark all with `[experiment]` in PR titles and `EXPERIMENTAL.md` in the directory

### Decision criteria for "promote to production" vs "kill"

After the 5 experiments, evaluate:

**Promote if**:
- YAML tables successfully replaced 50+ statements with cleaner, more queryable data
- PR review workflow for data changes is faster and more reliable than API-based statement curation
- `<FactTable>` renders well and is used on 3+ wiki pages
- LLM agent can propose table rows and human can review them efficiently

**Kill if**:
- Schema drift between entities is unmanageable
- YAML files become too large to review in PRs
- The build pipeline is too slow with table validation
- We need runtime queries badly enough to justify Postgres from the start
- The duplication problem (statements + tables) is worse than the problem we're solving

**Pivot to Postgres if**:
- Tables work conceptually but YAML is the wrong storage
- We need >1000 rows or complex cross-entity queries
- API consumers need structured data access

---

## Session log

### Session: 2026-03-06 (Anthropic ontology draft)

**What we did**: Built v5 of Anthropic ontology draft. Curated 122 statements into 44 actions (18 retract, 23 classify, 3 new properties). Verified citations (found 3 HIGH severity broken/wrong citations). Mapped the full Claude model ecosystem (16 entities, 97 statements, heavy duplication).

**Key findings**:
- Funding round + valuation join is the #1 pain point
- Employment data is essentially missing (no structured person-org-title-dates)
- Model entity profiles are extremely thin and duplicated
- Cross-entity utility score (0.297) is the weakest dimension
- Citation quality is worse than expected (broken URLs, wrong sources)
- The draft workflow itself (generate → review → iterate → apply) works well for the thinking part

**What we learned about the model**:
- Statements work well for: heterogeneous facts, narrative claims, policy positions
- Statements struggle with: uniform profiles, relational joins, temporal state tracking
- The current system has 67 properties but only 37 in use, and key categories (governance, research) have zero statements
- Duplication is a real problem without uniqueness constraints

---

## 20-Query Stress Test (2026-03-06)

Tested against production wiki-server API and YAML data files. Each query is something a real user, dashboard, or LLM agent might ask. Rated: **Clean** (single call, clean answer), **Awkward** (possible but requires hacks), **Impossible** (can't answer from current data).

**System stats at time of test:** 2,809 total statements (2,544 active, 265 retracted), 67 properties defined, ~50 distinct entities with statements. Three data layers: YAML facts (17 entity files), Postgres statements (wiki-server API), entity YAML (11 files).

### Results table

| # | Query | Category | Rating | Notes | Fix |
|---|-------|----------|--------|-------|-----|
| 1 | What is Anthropic's latest valuation? | Simple lookup | **Clean** | `GET /statements/current?entityId=anthropic&propertyId=valuation` returns $380B (2026-02) in one call. The `/current` endpoint correctly picks the latest active statement with `validEnd=null`. | -- |
| 2 | Show Anthropic's revenue over time | Time series | **Clean** | `GET /statements/by-entity?entityId=anthropic`, filter client-side by `propertyId=revenue`. Returns 10 clean data points from $10M (2022) to $19B (2026-03). Sorted by `validStart`. | Could add server-side `propertyId` filter to `/by-entity` to avoid downloading all 83 active statements just to use 10. |
| 3 | Compare all AI labs' valuations | Cross-entity comparison | **Awkward** | No cross-entity query endpoint. Must issue N separate `/current` calls (one per entity). Also must know entity slugs in advance. Tested 6 labs: Anthropic ($380B), xAI ($230B), SSI ($32B), Meta AI ($3.5B). OpenAI and DeepMind returned no data -- OpenAI's valuation is in YAML facts only (not synced to statements). | Need `GET /statements/compare?propertyId=valuation&entityIds=anthropic,openai,xai` or a `/by-property` endpoint that returns latest per entity. Also need YAML-to-statements sync for OpenAI. |
| 4 | Who are Anthropic's board members? | Relational | **Impossible** | No `board-composition` property has any statements (0 count). The `board-composition` property exists in the schema but is completely empty. Entity YAML has no board data. Statements have `founder` (7) and `position` (3) but nothing about board seats, committees, or independent directors. | Need either a `board_seats` table or structured statements with `propertyId=board-member` and `valueEntityId` pointing to person entities. The `position` property is too vague -- it mixes founders, hires, and team-level notes. |
| 5 | Who works at Anthropic right now? | Temporal state | **Awkward/Impossible** | Entity YAML `relatedEntries` lists 4 people (Dario, Chris Olah, Jan Leike, Daniela). Statements have 7 founders and 3 positions but: (a) no `valueEntityId` on most (just text like "Sam McCandlish (Chief Architect)"), (b) no `validEnd` to track departures, (c) no structured `employer` property. Can't distinguish current from former employees. Only 9/500 sampled statements use `valueEntityId` at all. | Need `employment(person_id, org_id, title, start_date, end_date)` table or statement conventions: `propertyId=position`, `valueEntityId=person-slug`, `validStart/validEnd` for tenure. Also need to actually populate `valueEntityId` instead of putting the name in `valueText`. |
| 6 | Total funding raised by all AI labs | Aggregation | **Awkward** | Must query N entities one at a time, extract `total-funding` from each, sum manually. Results are inconsistent: Anthropic shows $3.3B (stale Google investment total, not the actual $67B cumulative), OpenAI shows $13B (Microsoft only). No server-side aggregation. Some entities have no `total-funding` statement (DeepMind, Meta AI). | Need `GET /statements/aggregate?propertyId=total-funding&fn=sum` or at minimum a `/by-property` endpoint. Also need data quality: Anthropic's `total-funding` statements are investor-specific ($3.3B Google, $8B Amazon) rather than cumulative totals. |
| 7 | List all funding rounds for Anthropic with investors and valuations | Event-based | **Awkward** | 14 `funding-round` statements exist and are quite good -- each has a date, amount, and rich `statementText` mentioning investors. But: (a) investors are only in prose, not structured (no `valueEntityId` or qualifier like `investor:google`), (b) valuations are separate statements that must be mentally joined by date, (c) some rounds have `qualifierKey` (e.g., `round:series-b`, `investor:amazon-tranche-1`) but it's inconsistent -- 8 of 14 have no qualifier. | The qualifier system could solve this if consistently applied: `qualifierKey=round:series-g` on both the funding-round and valuation statements. Better: a `funding_rounds` table with `(date, series, amount, valuation, lead_investor, co_investors[])`. |
| 8 | What is OpenAI's current valuation? | Simple lookup | **Impossible** | `/statements/current?entityId=openai&propertyId=valuation` returns null. OpenAI has zero valuation statements (not even retracted ones). The data exists in YAML facts (`data/facts/openai.yaml`: $157B at 2024-12, $500B at 2025-10) but was never synced to statements. YAML facts and statements are completely disjoint data stores with no unified query. | Either sync YAML facts to statements automatically, or build a unified query layer that checks both. The fact that a core metric for a major entity is silently missing from one layer is a data integrity risk. |
| 9 | Anthropic headcount over time | Time series | **Awkward** | Returns 5 data points but with a data quality problem: 2024-09 shows 1,035 and 2024-12 shows 870 (decrease). Either one is wrong or they measure different things (FTEs vs contractors?). No qualifier distinguishes them. Also, 2022 (192) to 2023 (240) to 2024-09 (1,035) is a suspicious jump with no intermediate points. | Need `qualifierKey` to distinguish measurement basis (e.g., `basis:fte` vs `basis:total`). Data validation should flag non-monotonic time series for review. |
| 10 | What is Anthropic's gross margin? | Simple lookup | **Clean** | `/statements/current` returns 40% (2025) with proper text. One call, clean answer. | -- |
| 11 | Which entities have revenue data? | Cross-entity property scan | **Clean** | `GET /statements?propertyId=revenue&status=active&limit=200` returns 86 statements across 17 entities. The generic list endpoint with `propertyId` filter works as a cross-entity query. But: entity list includes odd entries (evan-hubinger, scaling-laws, ai-compute-scaling-metrics) that probably have misclassified statements. | Works technically, but data quality issues surface: revenue statements on person entities and concept entities suggest extraction errors. Need property-level entity-type constraints (revenue should only apply to organizations). |
| 12 | Compare headcount across AI labs | Cross-entity comparison | **Awkward** | Same N-call pattern as Q3. Results are sparse: Anthropic (4,074), xAI (287), SSI (20), MIRI (42). OpenAI and DeepMind return nothing. Meta AI returns 0 (nonsensical). No way to know which entities *should* have headcount data but don't. | Same fix as Q3: cross-entity property endpoint. Also need data completeness tracking -- the `coverage-scores/all` endpoint exists but requires separate call and doesn't filter by property. |
| 13 | When was Anthropic founded? | Simple lookup | **Clean** | `/statements/current?entityId=anthropic&propertyId=founded-date` returns "2021" with full founding narrative. Works in one call. | -- |
| 14 | What is Anthropic's revenue-to-valuation ratio? | Computed metric | **Awkward** | Requires 2 API calls (`/current` for revenue and valuation), then client-side division. Result: 5.0%. Neither data layer supports computed metrics. Every ratio, growth rate, or derived number must be computed client-side. | Could add `GET /statements/computed?entityId=anthropic&formula=revenue/valuation` or pre-compute common ratios as derived statements. More practically: frontend dashboard components should handle this, not the API. |
| 15 | What safety research does Anthropic do? | Qualitative/taxonomic | **Awkward** | Two partial answers from different layers: (a) entity YAML `relatedEntries` lists 7 research relationships (interpretability, scalable-oversight, deceptive-alignment, constitutional-ai, sleeper-agents), (b) statements have `safety-researcher-count` (265) and `interpretability-team-size` (50). But neither gives a structured, queryable view of "research areas with team sizes and key publications." | Need either a `research_areas` structured property with sub-fields, or better use of qualifiers on existing statements. The entity YAML relationships are the closest to answering this but aren't queryable via API. |
| 16 | What products has Anthropic launched? | Event list | **Clean** | `GET /by-entity`, filter by `propertyId=launched-date`. Returns 5 clean entries: Claude.ai (2023-07), Claude for Enterprise (2024-03), Claude Code (2025-02), Web Search API (2025-05), Claude 4 (2025-05). Each has rich `statementText`. Dates in `validStart` enable timeline view. | Could be improved with `valueEntityId` pointing to product entities (e.g., `claude-code`) for cross-referencing. Currently the product name is only in `valueText`. |
| 17 | How does Anthropic's market share compare to OpenAI's over time? | Cross-entity time series | **Awkward** | Must query 2 entities separately, then merge time series client-side. Worse: the data is not comparable. Anthropic's market share has 5 points including one with `qualifier=segment:enterprise-llm-overall` (32%) vs unqualified (42%) for the same date (2025-07). OpenAI has 8 points with wildly inconsistent values (21% to 81% for similar dates) because they measure different market segments. No way to know which ones are comparable. | Critical need for qualifier standardization: every market-share statement needs `qualifierKey=segment:X` specifying what market (enterprise LLM, consumer chatbot, API revenue, etc.). Without this, cross-entity comparison produces misleading charts. |
| 18 | What is Jan Leike's career history? | Person profile | **Impossible** | Statements for `jan-leike` are misclassified noise: `benchmark-score` (about a 2017 paper), `headcount` (about OpenAI's Superalignment team), `market-share` (about OpenAI's compute pledge). None of these are actually about Jan Leike as a person -- they were extracted from Jan Leike's wiki page but attributed to him as `subjectEntityId` when they're really about OpenAI. No employment history, no role transitions (OpenAI -> Anthropic), no structured career data. | Two problems: (1) statement extraction assigns `subjectEntityId` based on the wiki page, not the actual subject of the fact. "OpenAI committed 20% of compute" is not a Jan Leike statement. (2) No career/employment structured data exists. Need `position` statements with `valueEntityId=anthropic`, `qualifierKey=role:alignment-lead`, `validStart=2024-05`. |
| 19 | What properties exist and which are most used? | Schema exploration | **Clean** | `GET /statements/properties` returns all 67 properties with statement counts, categories, value types, and unit formats. Top: benchmark-score (152), total-funding (106), revenue (86). 30 properties have zero statements (board-composition, prediction, public-statement, etc.). Clean single call. | The 30 zero-count properties represent schema aspiration vs reality. Could prune unused properties or flag them as "planned." |
| 20 | Who is the CEO of Anthropic? / What company does Dario Amodei lead? | Bidirectional relational | **Awkward** | Forward (org->CEO): `GET /current?entityId=anthropic&propertyId=ceo` returns null -- no CEO statement for Anthropic. However, OpenAI has CEO statements (sam-altman) with `valueEntityId` properly set. Reverse (person->org): `GET /by-entity?entityId=dario-amodei` shows `propertyId=ceo` with `valueText=dario-amodei` and `propertyId=founder` with `qualifierKey=entity:anthropic`. The data exists but is inconsistently stored -- some from the org side, some from the person side, using different conventions. | Need bidirectional relationship indexing: if `anthropic` has `ceo=dario-amodei`, then `dario-amodei` should automatically have `employer=anthropic`. Or at minimum, consistent convention: always store relationships on the org side *and* the person side, with `valueEntityId` (not just `valueText`). |

### Score summary

| Rating | Count | % |
|--------|-------|---|
| **Clean** | 6 | 30% |
| **Awkward** | 10 | 50% |
| **Impossible** | 4 | 20% |

### Failure patterns

The 14 non-Clean queries fail for 5 recurring reasons:

1. **No cross-entity query endpoint** (Q3, Q6, Q12, Q17) -- The API is entity-centric. Every query starts with "give me data about entity X." There's no way to say "give me property P across all entities" except the generic `GET /statements?propertyId=P` which returns raw rows without grouping by entity or picking the latest value per entity. **Fix: Add `GET /statements/by-property?propertyId=P&status=active&latest=true` that returns one row per entity with the most recent value.**

2. **YAML facts and statements are disjoint** (Q3, Q8) -- OpenAI's valuation exists in YAML facts but not in statements. Users querying statements get nothing. There's no unified query layer. **Fix: Either auto-sync YAML facts to statements (already have `sourceFactKey` field), or build a query endpoint that checks both and merges results.**

3. **Relational data is unstructured** (Q4, Q5, Q18, Q20) -- Relationships between entities (employment, board membership, investment) are either missing, stored as prose in `valueText` instead of structured `valueEntityId`, or stored on only one side of the relationship. Only 9 out of 500 sampled statements use `valueEntityId`. **Fix: Enforce `valueEntityId` for relation-type properties (founder, ceo, position). Build reverse-relationship indexing.**

4. **Qualifiers are inconsistent** (Q7, Q9, Q17) -- The qualifier system exists but is sporadically used. Market share statements mix segments without qualifiers. Funding rounds sometimes have `round:series-b` and sometimes don't. **Fix: Define required qualifiers per property. Market-share must have `segment:X`. Funding-round must have `round:X`. Validate on ingestion.**

5. **No computed/derived values** (Q6, Q14) -- Sums, ratios, growth rates, rankings -- all require client-side computation. **Fix: This is acceptable for a data API. Dashboards and CLI tools should compute these. Don't add server-side computation unless there's a common query that many consumers need.**

### What this means for architecture decisions

The stress test confirms the strategy doc's analysis with concrete evidence:

- **Statements work well** for time series (Q2, Q9), simple lookups (Q1, Q10, Q13), event lists (Q16), and schema exploration (Q19). These are 30% of queries.

- **The #1 gap is cross-entity querying.** Half of all non-Clean queries would become Clean with a single new endpoint: `GET /statements/by-property?propertyId=X&latest=true`. This is cheap to build (one SQL query with `DISTINCT ON (subjectEntityId)`) and would unlock comparisons, rankings, and dashboards.

- **The #2 gap is relational data.** Board membership, employment, and investment relationships need either dedicated tables (Option B from the strategy doc) or much more disciplined use of `valueEntityId` + reverse indexing. This is the hardest problem -- it requires both schema changes and data migration.

- **The YAML/statements duality is a data integrity risk.** OpenAI having valuation data in YAML but not in statements means any statements-only consumer silently gets wrong answers. This needs to be resolved by either deprecating one layer or building a unified query.

---

## Clean Library Architecture (2026-03-06)

> Context: The user (who wrote Ken Standard) asks whether we should extract a clean, standalone knowledge base library — decoupled from the wiki rendering, wiki-server, and crux CLI — and whether to iterate on the existing system or do a focused rewrite inspired by Ken but with temporal support and stable IDs.

### The coupling problem today

The knowledge base logic is scattered across 6+ locations:

```
data/entities/*.yaml          ← entity definitions (11 YAML files)
data/facts/*.yaml             ← single-value facts (17 YAML files)
data/fact-measures.yaml       ← property definitions (191 measures)
apps/web/scripts/build-data.mjs  ← YAML→JSON transform (~1,200 lines)
apps/web/src/data/index.ts    ← runtime data access (entities, facts, backlinks)
apps/wiki-server/src/schema.ts   ← Postgres schema (statements table)
apps/wiki-server/src/routes/  ← API endpoints (statements, facts, entities)
crux/lib/wiki-server/         ← CLI client for API
crux/commands/statements.ts   ← CLI statement commands
```

**Why this is bad:**
- Changing how a "fact" works touches build-data (JS), data access (TS), wiki-server (TS), and the crux CLI (TS). Four repos' worth of changes.
- No single place defines "what is an entity?" — it's emergent from YAML structure + build-data transforms + entity-ontology.ts.
- Can't test the knowledge base without spinning up the wiki or wiki-server.
- The "two fact systems" problem exists because YAML facts and Postgres statements were built independently with no shared data model.

### What a clean library would look like

A standalone TypeScript package — call it `@longterm-wiki/knowledge-base` or `@longterm-wiki/kb` — that owns:

```
packages/kb/
├── src/
│   ├── types.ts          ← Core types: Thing, Fact, Property, Item
│   ├── graph.ts          ← In-memory graph: load, query, traverse
│   ├── schema.ts         ← Type schemas: "an organization has these properties"
│   ├── loader.ts         ← YAML/TOML → graph (reads data/ directory)
│   ├── validate.ts       ← Schema validation, ref checking, completeness
│   ├── inverse.ts        ← Computed inverse relationships
│   ├── query.ts          ← Query API: by-entity, by-property, cross-entity
│   ├── serialize.ts      ← Graph → JSON (for build-data), graph → YAML (for export)
│   └── ids.ts            ← ID generation, allocation, stability
├── data/                  ← YAML data files (moved from repo root data/)
│   ├── things/           ← Entity definitions
│   ├── facts/            ← Facts per entity (includes items/tables)
│   ├── properties/       ← Property definitions (replaces fact-measures.yaml)
│   └── schemas/          ← Type schemas (organization.yaml, person.yaml, etc.)
└── tests/
```

**What it does NOT own:**
- Wiki rendering (MDX, React components, Next.js) — that's the web app
- API serving (Hono routes, Postgres) — that's the wiki-server
- CLI commands — that's crux
- Statement curation (extraction, verification, LLM calls) — that's crux

**The boundary rule:** The KB library handles "what things exist, what facts do they have, how are they related, is the data valid?" Everything else is a consumer.

### Core data model (inspired by Ken, extended for time)

```typescript
// A Thing is any identifiable subject. Lightweight — just an ID, type, and metadata.
interface Thing {
  id: string;             // Stable slug: "anthropic", "claude-3-5-sonnet"
  stableId: string;       // Random 10-char ID: "a7xK2mP9qR" — survives renames
  type: string;           // References a schema: "organization", "person", "funding-round"
  name: string;           // Display name
  parent?: string;        // Parent thing ID (e.g., funding round → org)
  meta?: Record<string, unknown>;  // Arbitrary metadata
}

// A Fact is a (subject, property, value) triple with temporal and provenance info.
interface Fact {
  id: string;             // Random 10-char ID or content-hash
  subjectId: string;      // Thing ID
  propertyId: string;     // Property ID from the registry
  value: FactValue;       // Typed value (see below)
  asOf?: string;          // When this fact was true (ISO date)
  validEnd?: string;      // When this fact stopped being true (null = still true)
  source?: string;        // URL or citation key
  sourceQuote?: string;   // Relevant quote from source
  notes?: string;         // Free-text annotation
}

// Values are typed, not stringly-typed
type FactValue =
  | { type: "number"; value: number; unit?: string }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "ref"; value: string }    // Reference to another Thing ID
  | { type: "refs"; value: string[] } // Array of Thing IDs
  | { type: "json"; value: unknown }  // Escape hatch

// A Property is a self-describing definition.
interface Property {
  id: string;             // "revenue", "employed-by", "valuation"
  name: string;           // Display name
  description?: string;
  dataType: string;       // "number", "text", "date", "ref", etc.
  unit?: string;          // "USD", "percent", "tokens"
  category?: string;      // "financial", "people", "safety"
  inverseName?: string;   // "employed-by" → "employs"
  inverseId?: string;     // "employed-by" → "employer-of"
  appliesTo?: string[];   // Entity types this property is valid for
  display?: { divisor?: number; prefix?: string; suffix?: string };
}

// A TypeSchema defines expected properties for a Thing type.
interface TypeSchema {
  type: string;           // "organization", "person", "ai-model"
  required: string[];     // Property IDs that must have facts
  recommended: string[];  // Property IDs that should have facts
  items?: Record<string, ItemSchema>;  // Named item collections
}

// An ItemSchema defines a typed collection of sub-things.
interface ItemSchema {
  type: string;           // "funding-round", "board-seat", etc.
  fields: Record<string, FieldDef>;  // Expected fields per item
}
```

### How IDs work

Three kinds of IDs, serving different purposes:

**1. Slug IDs** (`anthropic`, `claude-3-5-sonnet`)
- Human-readable, used in URLs and YAML keys
- Can change (renames happen) — that's why we need stable IDs
- Globally unique within the knowledge base

**2. Stable IDs** (`a7xK2mP9qR`)
- Random 10-character alphanumeric, generated once, never changed
- Survives renames: if `anthropic` becomes `anthropic-inc`, the stable ID stays
- Used for syncing to external systems (wiki-server DB, APIs)
- Stored in YAML alongside the slug

**3. Fact IDs** (`f_8kX2pQ7mNr`)
- Random 10-char with `f_` prefix, generated when fact is created
- Or content-hash: `hash(subjectId + propertyId + value + asOf)` for auto-generated facts
- Used for server-side history tracking: "fact f_8kX2pQ7mNr was updated at time T"
- Content-hash IDs mean: if you regenerate the same fact from the same source, you get the same ID (idempotent sync)

**4. Numeric IDs** (`E42`)
- Legacy system for wiki URLs. The KB library tracks the mapping but doesn't own URL generation.
- These remain stable and are never reassigned.

**Rename workflow:**
```yaml
# Before rename:
anthropic:
  stableId: a7xK2mP9qR
  name: "Anthropic"

# After rename (stableId unchanged):
anthropic-inc:
  stableId: a7xK2mP9qR
  previousIds: [anthropic]  # For redirect/lookup
  name: "Anthropic, Inc."
```

The wiki-server syncs by stableId, not slug. So a rename in YAML doesn't break the DB linkage.

### How inverse relationships work (no manual duplication)

Define the relationship once:

```yaml
# data/properties/employed-by.yaml
id: employed-by
name: "Employed By"
dataType: ref
inverseId: employer-of
inverseName: "Employs"
```

Store it on one side only:

```yaml
# data/facts/jan-leike.yaml
facts:
  - property: employed-by
    value: { type: ref, value: anthropic }
    asOf: 2024-05
    source: "https://anthropic.com/news/jan-leike-joins-anthropic"
```

At build time, the KB library computes the inverse:

```typescript
// graph.ts
function computeInverses(graph: Graph): void {
  for (const fact of graph.facts) {
    const prop = graph.getProperty(fact.propertyId);
    if (prop.inverseId && fact.value.type === "ref") {
      graph.addDerivedFact({
        subjectId: fact.value.value,  // anthropic
        propertyId: prop.inverseId,   // employer-of
        value: { type: "ref", value: fact.subjectId },  // jan-leike
        asOf: fact.asOf,
        validEnd: fact.validEnd,
        derivedFrom: fact.id,
      });
    }
  }
}
```

Now querying "who does Anthropic employ?" returns Jan Leike without any manual `relatedEntries` duplication. And if Jan Leike's `employed-by` fact gets a `validEnd: 2025-12`, the inverse automatically disappears from Anthropic's current employees.

### How syncing to the server works

YAML is the source of truth. The wiki-server DB is a queryable mirror with history.

```
YAML files ──→ KB loader ──→ in-memory Graph ──→ serialize to JSON ──→ database.json (build-time)
                                                                    ──→ sync to wiki-server DB (deploy-time)

Wiki-server DB has:
- things table: stableId, slug, type, name, meta
- facts table: factId, stableId (FK), propertyId, value, asOf, validEnd, source
- fact_history: factId, field_changed, old_value, new_value, changed_at, changed_by
```

**Sync algorithm:**
1. Load YAML → Graph
2. Load DB current state → Graph
3. Diff: new things, removed things, changed facts
4. For each changed fact: write to `fact_history`, update `facts` table
5. The history table is the audit trail — "valuation changed from $350B to $380B on 2026-02-15"

**Migrations (the hard case):** If you rename a property (`safety-researcher-count` → `safety-team-size`), the sync sees all old facts as "removed" and all new facts as "created." To handle this cleanly:
- Add a `renamedFrom` field to property definitions
- The sync algorithm checks `renamedFrom` before treating a property change as delete+create
- For schema-level changes (adding/removing required fields from a TypeSchema), the validation layer flags warnings but doesn't block

### Iterate vs. rewrite — the decision

**Option I: Iterate on what we have**

Keep build-data.mjs, keep the current YAML structure, keep statements in Postgres. Add:
- `items:` sections to fact YAML files
- Entity-type schemas
- Inverse computation in build-data
- `<FactTable>` component
- Cross-entity query endpoint on wiki-server

**Pros:** No migration, works within existing CI/deploy, incremental
**Cons:** Keeps the coupling, keeps the dual-fact-system, build-data.mjs grows more complex

**Option II: Extract a clean KB library (incremental)**

Create `packages/kb/` as a new workspace package. Incrementally move data model logic there:
1. Start with types + loader (read existing YAML, produce a Graph)
2. Have build-data import from `@longterm-wiki/kb` instead of doing its own YAML parsing
3. Move validation logic from crux validators to KB's `validate.ts`
4. Move entity-ontology types from `apps/web/src/data/` to KB
5. Eventually, wiki-server's fact/statement routes import from KB for type definitions

**Pros:** Clean boundary, testable in isolation, can evolve independently
**Cons:** Initial setup cost (workspace config, import rewiring), transition period where both old and new code exist

**Option III: Greenfield KB library (prototype)**

Build `packages/kb/` from scratch with the new data model. Don't try to be backwards-compatible initially. Use it for ONE experiment (Anthropic funding rounds) to validate the model. If it works, migrate incrementally.

**Pros:** Cleanest design, no legacy constraints, fastest to prototype
**Cons:** Two systems running in parallel during transition, risk of "never finishing the migration"

### Recommendation: Option III (greenfield prototype), scoped tightly

Build the KB library as a standalone experiment. Scope:
1. **Types + loader**: Core interfaces + YAML reader
2. **One data file**: `data/kb/anthropic.yaml` with things, facts, and items (funding rounds, key people)
3. **Inverse computation**: Automated from property definitions
4. **Schema validation**: Check Anthropic data against an organization TypeSchema
5. **One rendering experiment**: `<KBTable>` component that reads from KB output

Do NOT try to replace build-data, entity-ontology, or the wiki-server. Run it in parallel for one entity. Evaluate after.

This is the "experiment flagged as experiment" approach — `packages/kb/` has its own `EXPERIMENTAL.md`, different code quality standards, and clear kill/promote criteria.

### Migration path if the experiment succeeds

```
Phase 1 (now):     KB library for Anthropic only. Parallel to existing system.
Phase 2 (week 2):  KB library for 5 entities. build-data imports KB for these 5.
Phase 3 (week 3):  KB library for all entities. build-data becomes a thin wrapper.
Phase 4 (week 4):  Wiki-server syncs from KB output. Statements table becomes history-only.
Phase 5 (month 2): build-data.mjs replaced by KB's serialize.ts. Full migration complete.
```

### Kill criteria

Kill the KB library experiment if:
- The YAML format is too verbose for the data (each funding round takes 10+ lines)
- Schema validation creates more friction than value
- Inverse computation has edge cases that require manual override >20% of the time
- The library can't represent something that statements currently handle well
- After 2 weeks, it hasn't replaced any existing functionality

### Open design questions

1. **YAML vs TOML?** Ken used TOML. YAML is what we already use everywhere. TOML is arguably better for structured data (explicit types, no indentation ambiguity). Recommend: stick with YAML for consistency, consider TOML if YAML causes parsing bugs.

2. **Where do items live?** Inline in the entity's fact file (`data/facts/anthropic.yaml → items:`) or in separate files (`data/kb/anthropic/funding-rounds.yaml`)? Separate files keep things smaller but add directory management. Recommend: inline initially, split later if files exceed ~200 lines.

3. **How does the KB library relate to `crux`?** The KB library is a dependency of crux, not the other way around. `crux` commands (like `crux statements improve`) would eventually call KB library functions. Crux stays as the CLI; KB is the data layer.

4. **Should the KB library handle Postgres at all?** Or is it purely a "YAML files → in-memory graph" tool, and the wiki-server handles its own DB? Recommend: KB library is file-based only. Server sync is a separate concern (either in crux or wiki-server).

5. **What about statements?** Long term, do statements become "facts in the KB that happen to be stored in Postgres" (full unification), or do they remain a separate system for narrative claims? The 20-query stress test suggests statements work fine for time series and simple lookups. The KB library would handle structured/relational data that statements handle poorly. Coexistence might be the right answer.

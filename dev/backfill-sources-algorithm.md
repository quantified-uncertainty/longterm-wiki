# `crux tb backfill-sources` — Algorithm Overview

Pseudocode for the full source-backfill pipeline. Cross-references key files at the bottom.

---

## Entry point

```
pnpm crux tb backfill-sources --apply [--limit=N] [--table=X]
                              [--max-cost=$] [--record-id=X] [--debug] [--verbose]
```

## Constants

```
PER_RECORD_BUDGET = $0.10
DEFAULT_MAX_COST  = $5.00
SELF_DOMAINS = [longtermwiki.com, longtermwiki.org, longterm.wiki,
                longterm-wiki.vercel.app, ea-crux-project.vercel.app]
```

---

## Phase 0 — Fetch the work queue

```
GET /api/sourcing/missing-sources?limit=N[&table=X]
  → for each table in {facts, personnel, investments, equity_positions,
                       policy_stakeholders, divisions, funding_rounds,
                       funding_programs, publications, page_citations}:
      SELECT rows WHERE source IS NULL OR source = ''
      (facts also excludes measure ∈ {website, description, logo, image})

Flatten all rows into one list.
If --record-id given, keep only that one.
```

## Phase 1 — Iterate each record

```
for record in records:

  if extractMatchTerms(record) is empty:    → skip "no search terms"
  if record looks like seed/test data:      → skip "test record"
  if total_cost_so_far ≥ max_cost:          → skip "budget cap" (and stop)

  process_record(record)            ← see Phase 2
```

## Phase 2 — `process_record(record)`

### Step 2.1 — Build inputs

```
matchTerms     = extractMatchTerms(record)        # per-table heuristic
mentionTargets = entitiesToMention(record)        # AND-of-OR variants:
                                                  #   personnel → [[person variants],
                                                  #                [org variants]]
                                                  #   else      → [[entity variants]]
claim          = humanizeClaim(record)            # "X's revenue is $1.5B"
searchQuery    = (entity_name + ' ' + description).slice(0, 200)
```

### Step 2.2 — `runResearch({ topic: searchQuery, budgetCap: $0.10, ... })`

```
inside research-agent.ts:
  a. Pre-seed from PG resources  (existing URLs already known)
  b. Run providers in parallel (whichever have keys):
       - Exa
       - Perplexity (via OpenRouter)  — has $ cost (searchCost)
       - SCRY (EA Forum / LessWrong)
       - GitHub / Semantic Scholar / Federal Register
         (only when entity type matches their routing rules)
  c. Normalize + dedupe URLs across providers + PG
  d. Take top maxUrlsToFetch = 5
  e. fetchSources(...) → scrape each URL (concurrency 5)
  f. Fact-extraction skipped (extractFacts: false in this caller)
  g. Register new URLs as bare resources in PG (best-effort)
  h. Return { sources: SourceCacheEntry[], cost breakdown }
```

### Step 2.3 — Verify each fetched source

For each `source` in `researchResult.sources`:

**Filter A — cheap rejections**
```
if isSelfDomain(source.url):              continue   # circular
if source.content.length < 50:            continue   # too short
```

**Filter B — entity mention gate** (every slot must match at least one variant)
```
for each slot in mentionTargets:
  accept if ANY variant satisfies contentMentionsEntity(content, variant, url)
    where contentMentionsEntity checks:
      - literal substring
      - slug-to-words ("center-for-ai-safety" → "center for ai safety")
      - accent-stripped (NFKD)
      - URL host/path contains the entity name
if any slot unmatched:    continue   # entityMissing++
(page_citations skip this gate entirely)
```

**Filter C — Haiku quote extraction (LLM call #1)**
```
buildQuoteExtractionPrompt(claim, entityName, content[:12_000])
→ Haiku returns { quotes: [up to 3 verbatim passages] }
cost.quoteExtractCost += this call's cost
if quotes is empty:       continue   # quoteNone++
```

**Filter D — anti-hallucination substring check**
```
verifiedQuotes = quotes.filter(q => verifyQuoteInContent(q, content))
  normalisation: lowercase, keep only [a-z0-9], collapse whitespace
if verifiedQuotes is empty:  continue   # quoteFabricated++
```

**Filter E — Sonnet entailment (LLM call #2)**
```
buildEntailmentPrompt(claim, verifiedQuotes, source.url, source.title)
→ Sonnet returns { supports: bool }
cost.entailmentCost += this call's cost
if not supports:           continue   # entailmentFailed++

matches.push({ url, snippet, provider, quotes: verifiedQuotes })
```

### Step 2.4 — Pick the winning source

```
if matches.length == 0:
  return { matched: false,
           reason: "no candidate passed verification (X no entity mention,
                    Y no supporting quote, Z fabricated, W entailment failed)" }

if matches.length == 1:
  chosen = matches[0]

else:
  # Haiku ranker (LLM call #3)
  buildRankingPrompt(record.description, entityName, matches)
  → Haiku returns { pickedIndex: N }
  cost.rankCost += this call's cost
  chosen = matches[pickedIndex]
  # (Cohere rerank was tested and lost 6/6 vs Haiku)
```

### Step 2.5 — Write back the chosen URL (apply mode only)

```
POST /api/sourcing/update-source
  { table, recordId, url: chosen.url }
Updates the table's source column ONLY (no other fields touched).
```

---

## Phase 3 — Aggregate + report

```
Track per-record outcomes:
  matched      → { url, provider, quotes, updated, cost }
  no-match     → { reason, cost }
  skipped      → { reason }   # no-terms / test / budget-cap

Always emit summary to stdout:
  - record counts (skipped/searched/matched/written)
  - cost breakdown (search / fact-extract / quote-extract / entailment / rank)
  - per-provider winning-source rollup
  - if --verbose: per-record list

Always write JSON report to dev/reports/backfill-unmatched-<timestamp>.json
containing every record with its outcome (URL + verbatim quotes for
matches; rejection reason for no-match; budget/skip reason for skipped).
Used for human spot-checking + post-hoc triage.
```

---

## Cost per record (typical, when a match is found)

| Stage | Cost |
|---|---|
| Perplexity search | ~$0.005 – $0.02 |
| Haiku quote-extract | ~$0.001 per fetched source × up to 5 |
| Sonnet entailment | ~$0.003 per quote-passing source |
| Haiku ranking | ~$0.001 (only if ≥2 matches survived) |
| **Total** | **~$0.01 – $0.05 / record** (well under $0.10 cap) |

---

## Design summary

Three LLM gates in series are the heart of it:

1. **Haiku pulls verbatim quotes** from the page that purport to support the claim
2. **Substring check** confirms the quotes weren't fabricated
3. **Sonnet judges entailment** — do the quotes actually support the claim?

Only sources that survive all three become candidates; if multiple survive, Haiku ranks them. The entity-mention pre-filter (with slug/accent/URL fallbacks) cuts the LLM call count by skipping pages that don't mention the entity at all.

## Key files

- `crux/commands/backfill-sources.ts:702` — `processRecord`
- `crux/lib/search/research-agent.ts:600` — provider fan-out
- `apps/wiki-server/src/routes/sourcing/missing-sources.ts` — work queue + writeback

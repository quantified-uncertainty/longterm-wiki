# TableBase Enrich (Subscription Mode)

Enrich structured data tables (personnel, funding rounds, investments, benchmarks) using Claude Code's subscription instead of API billing.

This skill replaces `crux tablebase improve` / `crux tablebase loop` (~$1-2/task via Sonnet API) with Claude Code's native web search and reasoning ($0/task via subscription).

**Schedule:** `/loop 4h /tablebase-enrich` for periodic runs.

**Do NOT run `/agent-session-start` — this skill manages its own workflow.**

## Phase 1: Identify tasks

Get the top enrichment tasks:

```bash
pnpm crux tablebase gaps --top=5
```

Then get the single highest-impact task as structured JSON:

```bash
pnpm crux tablebase next-task --format=json
```

If the output is `NO_TASKS`, report "All enrichment targets are complete or excluded" and stop.

Parse the JSON to extract: `id`, `taskType`, `entityId`, `entityName`, `table`, `existingRecordCount`.

## Phase 2: Research the entity

### 2a. Check existing records

```bash
pnpm crux tablebase existing <entityId> --table=<table>
```

Note what data already exists to avoid duplicates.

### 2b. Web search

Use the **WebSearch** tool (subscription-covered) to research the entity. Tailor queries by task type:

| Task Type | Search Queries |
|-----------|---------------|
| `personnel-enrichment` | `"<entityName>" leadership team`, `"<entityName>" CEO founder board of directors` |
| `funding-round-research` | `"<entityName>" funding round series`, `"<entityName>" raised valuation investors` |
| `investment-linking` | `"<entityName>" investment portfolio`, `"<entityName>" invested in` |
| `benchmark-result-fill` | `"<entityName>" benchmark results MMLU HumanEval`, `"<entityName>" performance scores` |
| `grant-grantee-backfill` | Check unlinked grant names against entity database |

Run 2-4 searches per task. Cross-reference facts across sources.

### 2c. Verify with WebFetch if needed

If search results reference specific pages with detailed data (e.g., Crunchbase, official about pages), use **WebFetch** to extract structured details.

## Phase 3: Resolve entity IDs

For each person, organization, or benchmark referenced in the data, resolve their entity ID:

```bash
pnpm crux tablebase resolve "Dario Amodei"
# Output: 111  dario-amodei  Dario Amodei

pnpm crux tablebase resolve "Dario Amodei" --ci
# Output: {"found":true,"stableId":"111","slug":"dario-amodei","name":"Dario Amodei"}
```

If `NOT_FOUND`, the person/entity is not in the database. **Skip records for unresolved entities** — do not fabricate IDs.

## Phase 4: Build and submit records

Construct a JSON array of records and submit via pipe:

### Personnel records
```bash
cat <<'RECORDS' | pnpm crux tablebase submit --table=personnel
[
  {
    "personId": "111",
    "organizationId": "A4XoubikkQ",
    "role": "CEO",
    "roleType": "key-person",
    "startDate": "2021-01",
    "isFounder": true,
    "source": "https://www.anthropic.com/company",
    "notes": "Co-founder and CEO since founding"
  }
]
RECORDS
```

### Funding round records
```bash
cat <<'RECORDS' | pnpm crux tablebase submit --table=funding-rounds
[
  {
    "companyId": "A4XoubikkQ",
    "name": "Series A",
    "date": "2021-05",
    "raised": 124000000,
    "leadInvestor": "Jaan Tallinn",
    "source": "https://example.com/article"
  }
]
RECORDS
```

### Benchmark result records
```bash
cat <<'RECORDS' | pnpm crux tablebase submit --table=benchmark-results
[
  {
    "benchmarkId": "mmlu-benchmark",
    "modelId": "claude-3-opus",
    "score": 86.8,
    "unit": "percent",
    "date": "2024-03-04",
    "sourceUrl": "https://example.com/benchmarks"
  }
]
RECORDS
```

### Record rules

- **Every record MUST have a `source` (or `sourceUrl` for benchmarks) field** with the URL where you found the data.
- **Only submit records for resolved entities.** If `resolve` returns NOT_FOUND, skip that record.
- **roleType** for personnel must be: `key-person`, `board`, or `career`.
- **Do not duplicate** records that already exist (check Phase 2a output).
- **Dates** should be `YYYY-MM-DD` or `YYYY-MM` or `YYYY`.

## Phase 5: Mark done and continue

After submitting records:

```bash
pnpm crux tablebase mark-done <taskId>
```

Then **repeat from Phase 1** for the next task. Process up to 5 tasks per session.

## Phase 6: Summary

After completing all tasks (or hitting 5), print a summary:

```
## TableBase Enrichment Summary

| # | Entity | Task Type | Records | Sources |
|---|--------|-----------|---------|---------|
| 1 | Anthropic | personnel-enrichment | 6 | anthropic.com |
| 2 | OpenAI | funding-round-research | 4 | crunchbase.com |

Total: X records across Y entities
Mode: subscription (no API cost)
```

## Guardrails

- **No fabrication.** Only submit data confirmed by web search results.
- **Skip unresolved entities.** Don't guess entity IDs.
- **Max 5 tasks per session** to keep session size manageable.
- **Cross-reference.** Verify key facts (funding amounts, roles) across 2+ sources when possible.
- **Conservative dates.** If you can only find a year, use `YYYY` — don't guess month/day.

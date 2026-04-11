# Source-Check Pipeline Consolidation Plan

## Current Pipelines

There are three separate verification pipelines that overlap significantly:

### 1. `factbase-sourcing` (`crux/commands/factbase-sourcing.ts`)
- **Scope**: FactBase facts (structured triples with source URLs)
- **Entry point**: `crux fb sourcing --entity=X`
- **Flow**: Load facts from FactBase YAML → fetch source content → single-fact LLM verification → store evidence
- **LLM model**: Haiku (via `callLlm`)
- **Storage**: Writes to `source_check_evidence` table via wiki-server API
- **Strengths**: Deep integration with FactBase graph, entity resolution, property formatting

### 2. `sourcing-orchestrate` (`crux/commands/sourcing-orchestrate.ts`)
- **Scope**: Combined — FactBase facts, TableBase structured records, and entity web search
- **Entry point**: `crux sourcing orchestrate --type=fact|record|entity`
- **Flow**: Loads all eligible items → prioritizes by staleness/importance → fetches content → LLM verification → stores verdicts
- **LLM model**: Haiku (via shared `callLlmForSourcing`)
- **Storage**: `source_check_evidence` + aggregate verdicts on entities
- **Strengths**: Budget controls, prioritization, cross-type orchestration, web search fallback

### 3. `sourcing-wiki-pages` (`crux/commands/sourcing-wiki-pages.ts`)
- **Scope**: Wiki page prose — extracts factual claims from MDX content and verifies against footnoted sources
- **Entry point**: `crux w sourcing-wiki-pages --page=X`
- **Flow**: Load MDX → LLM claim extraction → match claims to footnotes → fetch source content → verify claims → detect stale temporal references
- **LLM model**: Haiku (claim extraction + verification)
- **Storage**: `source_check_evidence`
- **Strengths**: Prose-level verification, footnote matching, temporal staleness detection, FactBase cross-reference

### Adjacent: `claim-verification` job handler (`crux/lib/job-handlers/claim-verification.ts`)
- **Scope**: Proposed claims from the claims API — job queue driven
- **Flow**: Load proposed claims → fetch resource content → multi-claim batch LLM verification → store verdicts
- **Not a standalone pipeline** but shares the same verification infrastructure

### Adjacent: `tablebase/sourcing.ts` (`crux/tablebase/sourcing.ts`)
- **Scope**: TableBase records (personnel, funding, etc.) — uses Anthropic Batch API for 50% cost discount
- **Flow**: Deterministic checks (URL reachability, field presence) + LLM batch verification
- **Distinct approach**: Uses the Batch API instead of real-time calls

## Overlap Analysis

| Capability | factbase | orchestrate | wiki-pages | claim-verification |
|---|---|---|---|---|
| Source content fetching | via shared lib | via shared lib | via shared lib | via shared lib |
| LLM verification call | own impl | shared `callLlmForSourcing` | own impl | own impl |
| Evidence storage | shared `storeSourcingEvidence` | shared | shared | shared |
| Budget tracking | manual | built-in | built-in | N/A (job queue) |
| Prioritization | none | built-in | page importance | N/A |
| Content extraction | N/A | N/A | claim extraction from prose | pre-extracted claims |

**Shared utilities** already extracted to `crux/lib/sourcing/`:
- `source-fetcher.ts` — URL fetching with paywall detection, caching, HTML-to-text
- `llm-checker.ts` — `callLlmForSourcing()`, verdict validation
- `verdict-handler.ts` — `storeSourcingEvidence()`, `storeAggregateVerdict()`
- `wiki-page-claims.ts` — claim extraction, footnote parsing, temporal staleness
- `record-fields.ts` — structured record field extraction for verification
- `types.ts` — shared types and constants

## Recommendation: `sourcing-orchestrate` as canonical

The orchestrator should be the single entry point for all verification work because:

1. It already handles multiple item types (facts, records, entities)
2. It has budget controls and prioritization built in
3. Adding wiki-page claims as a fourth item type is straightforward
4. The job-queue-based `claim-verification` handler is complementary (async processing), not competing

## Consolidation Steps

### Phase 1: Absorb `factbase-sourcing` into orchestrator
- The orchestrator already handles `--type=fact`. The standalone command adds no unique functionality.
- **Action**: Deprecate `crux fb sourcing` with a message pointing to `crux sourcing orchestrate --type=fact`.
- **Risk**: Low — the orchestrator already passes through to the same shared utilities.

### Phase 2: Add wiki-page verification to orchestrator
- Add `--type=wiki-page` to the orchestrator
- Reuse `extractWikiPageClaims` and `matchClaimToFootnote` from `wiki-page-claims.ts`
- Integrate page importance scores for prioritization
- **Action**: Add a `wiki-page` item type to the orchestrator's scoring and processing loop.
- **Risk**: Medium — wiki-page verification has a two-step flow (extract claims, then verify each) that needs careful integration with the orchestrator's single-pass design.

### Phase 3: Unify LLM call patterns
- `factbase-sourcing` and `sourcing-wiki-pages` each have their own LLM prompt construction.
- **Action**: Migrate remaining callers to `callLlmForSourcing()` from `llm-checker.ts`, extending it with a `mode` parameter if prompt variations are needed.

### Phase 4: Batch API integration
- `tablebase/sourcing.ts` uses the Batch API for cost savings.
- **Action**: Add a `--batch` flag to the orchestrator that collects all verification requests and submits via Batch API instead of real-time calls. This is orthogonal to the other phases.

## Utilities Already Shared (no extraction needed)

All core utilities are already in `crux/lib/sourcing/`:
- `fetchSourceContent` — content fetching with cache and paywall detection
- `callLlmForSourcing` — LLM verification with structured response parsing
- `storeSourcingEvidence` — evidence persistence
- `storeAggregateVerdict` — entity-level aggregate verdict computation
- `extractWikiPageClaims` — claim extraction from MDX prose
- `parseFootnotes` / `matchClaimToFootnote` — footnote resolution
- `detectStaleTemporal` — temporal reference staleness detection

The main consolidation work is routing, not utility extraction.

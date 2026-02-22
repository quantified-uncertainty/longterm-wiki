# Scaled Hallucination Hunting & Content Quality Plan

> Created: 2026-02-22
> Status: Proposal
> Budget: $500–$3,000
> Scope: 300 page updates + 200 new pages

## Current State (678 pages, 642 entities)

| Metric | Value |
|--------|-------|
| Pages assessed for risk | 534 |
| **High risk** (≥70) | **116** (22%) |
| Medium risk (40-69) | 320 (60%) |
| Low risk (<40) | 98 (18%) |
| **Zero citations** | **200** (37%) |
| No human review | 116 (100% of high-risk) |
| Broken citations | 9 pages (HTTP 403/503) |

**Dominant risk factors**: no-human-review (100%), no-citations (85%), biographical-claims (60%), few-external-sources (34%), low-quality-score (29%).

Worst pages: person/org pages with zero citations and low quality scores.

## What Already Exists

1. **Content Improve Pipeline** (v1 + v2 orchestrator) — Full multi-phase pipeline. v2 uses Opus-directed agent with composable tools (research, rewrite-section, audit-citations, add-entity-links). Costs ~$5-10/page (standard), ~$10-25/page (deep).

2. **Three Hunting Agents** — `reference-sniffer` (claim extraction + LLM verification), `description-auditor` (YAML/frontmatter/overview consistency), `cross-reference-checker` (contradictions across pages). All cheap (~$0-0.50/page).

3. **Job Queue + Workers** — PostgreSQL-backed queue with `page-improve`, `page-create`, `citation-verify`, `batch-commit` handlers. GHA workflow runs 3 parallel workers. `crux jobs batch improve <pages>` already works.

4. **Auto-Update Orchestrator** — Sequential pipeline with hard budget caps, tier-based cost tracking, importance-sorted execution. Proven at ~$30/run, 5-10 pages.

5. **Citation Verification & Quotes** — Verify citations against actual source content, extract supporting quotes, track verification state per-page.

## Gaps Between Existing Systems

1. **No "scan → fix" pipeline**: Hunting agents produce findings but don't feed them as `--directions` to the improve pipeline.
2. **No batch triage**: `--tier triage` works per-page (~$0.08) but no orchestrated "triage 200 pages" command.
3. **Worker throughput**: 3 GHA workers × ~10 pages/hour (standard) = limited for large runs.
4. **No bulk progress dashboard**: Auto-update dashboard tracks news runs, not hallucination sweeps.

## Phase 0: Dry Run & Triage ($15-30)

**Goal**: Categorize all pages into action buckets before spending on improvements.

1. **Cross-reference checker across all pages** (~$0, regex-only)
   - Find contradictions to fix first (so improvements don't bake in wrong facts)

2. **Reference-sniffer `--no-llm` on all high-risk pages** (~$0)
   - Count uncited factual claims per page (dates, numbers, percentages)

3. **Batch triage top 200 pages** (~$16, 200 × $0.08)
   - Classify each as: skip | polish | standard | deep

4. **Build manifest**: Combine risk score + triage result + uncited-claim count + contradictions into prioritized list.

**New tooling**: `crux evals scan` (batch hunting agent runner), `crux content triage-batch`.

## Phase 1: Pilot Batch ($50-100)

**Goal**: Validate pipeline at scale on 10-20 worst pages.

1. Pick 10-20 highest-risk, most-viewed pages (person + org with zero citations)
2. Run standard-tier improvements via job queue with targeted directions
3. Post-improvement: re-run reference-sniffer + citation-audit
4. Measure: cost/page, risk score reduction, citation increase, residual uncited claims
5. Manual spot-check 3-5 pages

**Success criteria**: Risk score ≥20pt drop, ≥5 citations/page, no new contradictions.

**Infrastructure needed**:
- `crux evals scan` command (batch hunting agents)
- Direction templates that feed hunting findings into improve pipeline
- Post-improvement verification step

## Phase 2: Scaled Page Updates ($600-900)

**Goal**: Fix remaining 200+ high/medium-risk pages in batches of 30-50.

| Batch | Pages | Tier | Est. Cost | Focus |
|-------|-------|------|-----------|-------|
| A | 30 highest-risk | standard | ~$200 | Zero-citation org + person pages |
| B | 30 next-highest | standard | ~$200 | Zero-citation models + risk pages |
| C | 50 medium-risk | polish | ~$125 | Pages with some citations but gaps |
| D | 50 medium-risk | polish | ~$125 | More medium-risk pages |
| E | 40 cross-ref conflicts | standard | ~$260 | Pages with contradictions |
| **Total** | **200** | mixed | **~$910** | |

**Execution per batch**:
1. Submit via `crux jobs batch improve` with risk-factor-specific directions
2. 5-8 GHA workers process jobs
3. `batch-commit` creates PR
4. Post-improvement reference-sniffer scan
5. Human reviews PR summary
6. Merge

**Throughput (5-8 workers)**: ~15-25 pages/hour (standard), ~40-60/hour (polish).

**Infrastructure needed**:
- Bump GHA workers to 5-8
- `crux jobs batch-status <batchId>` for monitoring
- Post-improvement scanning in batch-commit handler
- Direction templates per risk factor

## Phase 3: New Page Creation ($300-1500)

**Goal**: Add 100-200 new pages.

1. Gap analysis: entities referenced but without pages
2. Batch create via job queue
3. Post-creation improvement (standard tier) for citations
4. Cost: $5-8/page standard × 200 = $1000-1600 (or budget tier at $2-3/page)

**Infrastructure needed**: `crux content gap-analysis` command.

## Phase 4: Continuous Quality (ongoing, ~$50-100/month)

1. Auto-update already handles news-driven updates (~$30/day)
2. Add reference-sniffer `--no-llm` to PR CI (free, fast)
3. Monthly quality sweep: triage + improve drifted pages
4. Weekly broken citation monitoring
5. Cross-ref check on PRs that touch shared entities

## Cost Summary

| Phase | Pages | Est. Cost | Timeline |
|-------|-------|-----------|----------|
| 0: Triage | 534 scan, 200 triage | $15-30 | 1 session |
| 1: Pilot | 10-20 updates | $50-100 | 1-2 sessions |
| 2: Scaled Updates | 200 updates | $600-900 | 2-4 sessions |
| 3: New Pages | 100-200 new | $300-1500 | 3-8 sessions |
| 4: Continuous | ongoing | $50-100/mo | ongoing |
| **Total** | **~500 page actions** | **$1000-2500** | |

## New Tooling (Priority Order)

1. **`crux evals scan`** — Batch hunting agents. Options: `--agents`, `--pages`, `--no-llm`, `--output`.
2. **Direction templates** — Risk factor → improvement directions mapping.
3. **`crux jobs batch-status`** — Batch progress monitoring.
4. **Post-improvement verification** — Reference-sniffer + citation-audit in batch-commit.
5. **Increase GHA workers** — Bump matrix to 5-8 for batch runs.
6. **`crux content triage-batch`** — Batch triage via job queue.
7. **CI quality regression check** — Reference-sniffer `--no-llm` on changed pages in PRs.

## Iteration Strategy

**Week 1**: Build `crux evals scan` + direction templates. Run Phase 0 triage. Pilot 10 pages. Measure.

**Week 2**: Adjust based on pilot. Run Phase 2 Batch A (30 pages). Build batch-status. Review.

**Week 3-4**: Run Phase 2 Batches B-E (170 pages). Start Phase 3 gap analysis + first new pages.

**Ongoing**: Phase 4 monitoring.

## Key Insight

Per-page improve cost is well-understood ($5-8 standard, $2-3 polish). The biggest lever is **direction quality** — generic directions waste money (LLM rewrites prose without fixing actual risks). Directions informed by hunting agent findings target the specific unsourced claims on each page.

The v2 orchestrator (Opus-directed) is especially well-suited: it can decide per-page whether to research, audit citations, or just polish — adapting to what each page actually needs rather than running a fixed pipeline.

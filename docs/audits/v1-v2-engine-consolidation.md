# V1/V2 Page-Authoring Engine — Consolidation Audit

**Linear**: [QUA-556](https://linear.app/quantifieduncertainty/issue/QUA-556)
**Status**: Draft 2026-04-16
**Scope**: `crux/authoring/` — the page-improve/page-create authoring pipeline(s). Not the validator orchestrators (QUA-529), not the source-check pipeline.

---

## TL;DR

The labels "V1" and "V2" encode a false progression. V1 is not the old version; V2 is not the new version. They are **two different orchestration strategies** over a shared domain, labeled as if one replaces the other.

The actual load-bearing unit is neither the V1 pipeline runner nor the V2 orchestrator — it is **V1's phase library** (`crux/authoring/page-improver/phases/`), which is imported directly by auto-update's batch pipeline and reused standalone by `page-review.ts`. V2's only exclusive capability (batch via Anthropic Batch API) is **not** used by the biggest batch consumer (auto-update rolled its own batch implementation on top of V1 phases).

**Recommendation**: **Option E (Hybrid).**
1. Rename the flag/labels first (`--engine=v1|v2` → `--engine=fixed|agent`). Cheap, unblocks clear thinking.
2. Extract phase modules to `crux/authoring/phases/` so both pipelines compose the same primitives. Auto-update stops importing from a package whose name (`page-improver`) suggests it is only for `crux w improve`.
3. Defer "migrate auto-update to agent pipeline" and "delete either engine" until after parity benchmarks exist — currently there are **zero** end-to-end tests comparing the two engines on the same page.

---

## 1. What each engine actually is

### V1 — "fixed pipeline" (`crux/authoring/page-improver/`)

A **sequential runner** that calls 12 typed phases in a hardcoded order based on tier. The orchestration is deterministic:

```
triage → analyze → research → improve (or improve-sections) → enrich → review → gap-fill
  → adversarial-review → adversarial-loop (deep tier) → citation-audit → validate
```

Each phase is a typed TypeScript module with explicit input/output shapes (`AnalysisResult`, `ResearchResult`, etc.). The pipeline is ~712 LOC (`pipeline.ts`) + 12 phase modules (~2,550 LOC). Models: Sonnet throughout.

Entry point: `crux/authoring/page-improver/index.ts:268-289` — routes to `runPipeline()`.

### V2 — "agent pipeline" (`crux/authoring/orchestrator/`)

An **LLM-agent loop**: Opus as orchestrator, ~21 composable tools in `orchestrator/tools/` that the LLM picks from. No hardcoded phase order; the model decides what to call. Quality gate runs after the agent loop; up to 2 refinement cycles.

Models: Opus (orchestrator) + Sonnet (writers inside tools). ~3,963 LOC including tools (21 tool modules) and tests.

Entry point: `runOrchestratorPipeline()` in `crux/authoring/orchestrator/index.ts`. Invoked from:
- `page-improver/index.ts:268` when `--engine=v2`
- `batch-runner.ts:22` for `--batch=`/`--batch-file=` (V2 only)
- `page-creator.ts:502` when `--engine=v2 && !singlePhase`

### Auto-update — "batch-improve" (`crux/auto-update/batch-improve.ts`)

**A third path, not V1 or V2.** Runs `analyzePhase` + `researchPhase` from V1 for each page (these need tool use), then hand-builds Anthropic Batch API calls for the improve step using `lib/anthropic-batch.ts`. File comment (lines 1-19) explicitly explains why it doesn't call V2:

> Limitations:
> - No tool use during improve (batch API doesn't support tool_use)
> - No adversarial loop or section-level rewriting (batch is single-turn)

This path ships daily via `.github/workflows/auto-update.yml`. It is the single largest consumer of authoring-pipeline code and it **does not use V2** — the engine whose marquee feature is batch mode.

### Flagship-curate (`crux/commands/flagship-curate.ts`)

Does not touch either authoring engine. Calls `callLlm()` directly. Included here only to disambiguate — "engine" in flagship-curate does not refer to V1/V2.

---

## 2. File inventory

| Group | LOC | Contents |
|---|---:|---|
| V1 (fixed pipeline) non-test | 4,681 | `page-improver/*.ts` + `phases/*.ts` (15 files, incl. prompts + json-parsing) |
| V2 (agent pipeline) non-test | 3,963 | `orchestrator/*.ts` + `orchestrator/tools/*.ts` (21 tool modules + registry/index/types/metrics) |
| V2-only batch driver | 987 | `crux/authoring/batch-runner.ts` |
| Auto-update batch-improve | ~700 | `crux/auto-update/batch-improve.ts` (uses V1 phases + its own Anthropic Batch API wrapper) |

Counts verified 2026-04-16 via `find crux/authoring/page-improver -name '*.ts' ! -name '*.test.ts' | xargs wc -l` (and similar for orchestrator).

### V1 phase modules — this is the valuable part

| Phase | LOC | Purpose |
|---|---:|---|
| `triage.ts` | 282 | Cheap news check + citation-health score to auto-select tier |
| `analyze.ts` | ~79 | Gap analysis (Sonnet); missing content + research needs |
| `research.ts` | ~192 | Web + SCRY search; accumulates sources for improve |
| `improve.ts` | ~57 | Single-pass content rewrite (Sonnet) |
| `improve-sections.ts` | 325 | Per-section rewrite (alternative to monolithic improve) |
| `enrich.ts` | ~75 | Post-improve entity-link / fact-ref injection |
| `review.ts` | ~65 | Quality + wiki-convention check |
| `gap-fill.ts` | ~58 | Fixes review issues (one pass) |
| `adversarial-review.ts` | 146 | Diagnostic questions (deep tier) |
| `adversarial-loop.ts` | 251 | Iterates adversarial → gap-fill (max 2 cycles) |
| `citation-audit.ts` | 155 | Per-citation fact-check gate; blocks apply |
| `validate.ts` | 147 | Runs rule engine; auto-fixes dollar-signs, links, frontmatter |

Note: `json-parsing.ts` and `prompts.ts` under phases/ are shared utilities, not phases.

### V2 tool modules — shims over similar domain logic

21 tool files: `academic-lookup`, `add-entity-links`, `add-fact-refs`, `add-references`, `adversarial-review`, `audit-citations`, `check-cross-references`, `create-visual`, `deep-citation-check`, `edit-frontmatter`, `get-page-metrics`, `github-lookup`, `query-wiki-context`, `read-page`, `read-related-page`, `rewrite-section`, `run-research`, `split-into-sections`, `suggest-cross-links`, `validate-content`, `view-edit-history`. Plus `registry.ts`, `index.ts`, `types.ts`, `metrics.ts`.

Most tools are thin — the heavy lifting (LLM calls, research backend, citation checker) is in `crux/lib/` or duplicated inline.

---

## 3. What's actually shared

Contrary to the "V1 vs V2" framing, almost nothing is shared:

**V2 imports from V1:**
- `orchestrator/index.ts:25` imports `repairFrontmatter`, `stripRelatedPagesSections` from `page-improver/utils.ts`
- `page-review.ts:2` imports `adversarialReviewPhase` from `page-improver/phases/adversarial-review.ts` (standalone use, not inside V1 pipeline)
- That's it.

**Auto-update imports from V1:**
- `auto-update/batch-improve.ts:27-36` imports: `analyzePhase`, `researchPhase`, `PageData`, `AnalysisResult`, `ResearchResult`, `PipelineOptions`, `ROOT`, `getFilePath`, `getImportPath`, `loadPages`, `findPage`, `setApiDirectMode`, `buildImproveContext`, `postProcessImproveResult`. **Heavy dependency on V1 internals.**
- `auto-update/feed-fetcher.ts:20` imports `executeWebSearch` from `page-improver/api.ts`

**V2 tools do NOT reuse V1 phases.** The agent rebuilt equivalent functionality as tools (`run-research` tool ≠ `researchPhase`, etc.). This is the consolidation opportunity — and also the main risk (behavioral drift between the two research implementations).

**Shared utilities in `crux/lib/`:** `llm.ts`, `anthropic.ts`, `cost-tracker.ts`, `resilience.ts`, `output.ts`, `content/section-splitter.ts`. Both engines use these. No V1/V2 tension here.

---

## 4. Production usage — verified

Method: `grep -rn "\-\-engine\|engine: ['\"]v" .github/ crux/ scripts/` + workflow inspection + Linear archaeology.

| Path | Engine | Invocation |
|---|---|---|
| `crux w create` default | V1 | `pnpm crux w create ...` (no `--engine`) |
| `crux w create --engine=v2` | V2 | Hand-run only. No CI path. |
| `crux w improve` default | V1 | Same. |
| `crux w improve --engine=v2` | V2 | Hand-run only. |
| `crux w improve --batch=...` | V2 (forced) | Hand-run only. Errors if `--engine` ≠ v2 (`page-improver/index.ts:176-179`). |
| Auto-update (`.github/workflows/auto-update.yml`, daily 06:00 UTC) | **V1 phases + custom batch API** | Imports V1 phase modules. Does not go through V1 runner or V2. |
| Flagship-curate weekly cron | Neither | Direct `callLlm()`; not an authoring-pipeline consumer. |
| `crux/evals/pilot.ts` | User-selectable | Default v1; explicit `--engine=v2` supported. |

**V2 in CI: zero matches.** V2 is only invoked when a human types `--engine=v2` or `--batch=...`.

---

## 5. Divergence points — where behavior actually differs

Verified by reading code, not inferred from architecture diagrams:

| Aspect | V1 | V2 | Evidence |
|---|---|---|---|
| Phase ordering | Hardcoded sequence | LLM-selected | `pipeline.ts:150-250`; `orchestrator.ts:355-450` |
| LLM models | Sonnet throughout | Opus orchestrator + Sonnet writers | `orchestrator.ts:22` (MODELS) |
| Refinement loop | Adversarial loop (deep tier only, max 2 cycles) | Quality-gate feedback loop (all tiers, `MAX_REFINEMENT_CYCLES=2`) | `orchestrator.ts:68` |
| Cost model | Implicit (per-phase) | Explicit per-tool + per-tier budget | `orchestrator/types.ts:36-96`; `orchestrator/tools/registry.ts:82-85` |
| Research budget | Hardcoded per phase (1-3 queries) | Per-tier explicit (polish=0, standard=3, deep=8) | `orchestrator/types.ts:36-96` |
| Citation handling | Gate phase after improve | Tools (`audit-citations`, `deep-citation-check`) in agent loop | `phases/citation-audit.ts`; `orchestrator/tools/audit-citations.ts` |
| Batch mode | Not supported | Supported via `batch-runner.ts` + Anthropic Batch API | `batch-runner.ts:1-50` |

These are **legitimately different architectural choices**, not superficial duplication. An extraction refactor can consolidate the *primitives* (analyze, research, citation-check) but the orchestration strategies are meaningfully different.

---

## 6. Test coverage asymmetry

| Area | Test LOC | Shape |
|---|---:|---|
| V1 phase unit tests | ~1,200 | `phases/*.test.ts` — per-phase, granular |
| V2 orchestrator integration | ~500 | `orchestrator.test.ts` — agent-loop + tool-use |
| V2 quality-gate | 282 | `quality-gate.test.ts` |
| Shared (grading, batch quality, suggest-links) | ~800 | Used by both engines |
| **End-to-end V1 ↔ V2 output comparison** | **0** | None exist. |

There is **no test that runs both engines on the same page and compares output quality**. Any decision to "replace V1 with V2" or vice versa has no empirical support today.

### Qualitative V2 evidence (not a benchmark)

Prior test PRs exercised V2 successfully on real pages without a paired V1 run:

- **PR #752** — V2 shake-out on 5 pages across polish/standard/deep tiers. Found and fixed 3 bugs (#733 section-writer truncation, #734 firecrawl, #735 gate thresholds). 4/5 pages passed the quality gate cleanly after fixes.
- **PR #772** — V2 on 3 high-importance pages at standard tier (`alignment-robustness-trajectory`, `capability-alignment-race`, `alignment-progress`). +54% word count, 15-16 citations, 23-107 EntityLinks, ~$6-7/page. Quality gate passed on all 3 with zero refinement cycles.
- **PR #815** — fixed V2 quality issues (dollar-sign corruption, firecrawl API breakage, timeout handling) discovered during "~\$17 spent on 4 test pages in preparation for the \$500 production batch run."

These establish that **V2 produces publishable output** on non-trivial pages at reasonable cost. They do **not** establish that V2 outperforms V1 — the comparison was never run. Any impression of "V2 did better" comes from watching V2 work well on pages where V1 was not also tested.

A proper head-to-head benchmark is tracked in [QUA-557](https://linear.app/quantifieduncertainty/issue/QUA-557).

---

## 7. Options — evaluation

### Option A: Extract shared phases
Move phases from `page-improver/phases/` to `crux/authoring/phases/`. V1 pipeline composes them in a fixed order; V2 tools become thin wrappers that call the same phase functions. Auto-update continues to import (from the new path).

- **Clarity win**: medium — file layout stops lying about ownership
- **Code deletion**: medium — V2's `run_research` tool can delegate to `researchPhase`; duplicate logic collapses
- **Risk**: medium — V2 tools currently have different input/output shapes than phases; wrappers are required
- **Effort**: ~1-2 weeks

### Option B: Migrate auto-update to V2, deprecate V1
Port auto-update's batch pipeline to call `runOrchestratorPipeline`. Eventually delete V1.

- **Clarity win**: large — single authoring engine
- **Risk**: **high** — V2 uses Opus (costs unknown), has less coverage, lacks batch-as-implemented-in-auto-update (no tool use in Batch API), and no parity tests exist. Auto-update is a load-bearing production pipeline.
- **Effort**: months, gated on parity benchmarks that don't exist
- **Blocking unknowns**: Opus-vs-Sonnet cost per improve run; V2 quality delta on daily pages; whether V2's batch-runner can replace auto-update's custom Batch-API implementation

### Option C: Delete V2, bolt batch-mode onto V1
Extract batch capability to V1. Delete orchestrator/.

- **Clarity win**: large
- **Cost**: throws away ~4k LOC of V2 work
- **Assumption**: agent architecture offers no quality upside over fixed pipeline. Currently **unverified** — no tests exist to confirm or refute.
- **Effort**: medium

### Option D: Rename only
`--engine=v1|v2` → `--engine=fixed|agent`. Rename `crux/authoring/page-improver/` → `crux/authoring/fixed-pipeline/` and `orchestrator/` → `agent-pipeline/`. Drop V1/V2 language in docs.

- **Clarity win**: large — immediately kills the "V1 is old" misconception
- **Code consolidation**: zero — the duplication remains
- **Risk**: low — rename-only changes, backward-compat aliases for CLI flags
- **Effort**: ~1-2 days

### Option E: Hybrid (D → A)
Rename now (Option D). Then extract shared phases (Option A). Re-evaluate B/C after both ship with updated benchmarks.

- Gets the cheap clarity win first
- Doesn't commit to a migration direction before parity data exists
- Splits the work into two independently-shippable PRs

---

## 8. Recommendation

**Option E. Do Option D this sprint; Option A next.**

### Sequence

1. **PR 1 — Rename (QUA-556 or split-off follow-up)**
   - CLI: `--engine=v1|v2` → `--engine=fixed|agent`. Keep `v1`/`v2` as deprecated aliases for one release cycle.
   - Directories: `page-improver/` → `fixed-pipeline/`; `orchestrator/` → `agent-pipeline/`.
   - Update `data-architecture-overview.mdx:320-335` to use `fixed`/`agent` language.
   - Update help text in `content.ts:89`, `page-improver/index.ts:113`, `batch-runner.ts:13-15`.
   - No code restructure. ~1-2 days.

2. **PR 2 — Extract phases (follow-up ticket)**
   - Move `fixed-pipeline/phases/` → `crux/authoring/phases/`.
   - Update imports in: `fixed-pipeline/pipeline.ts`, `page-review.ts`, `auto-update/batch-improve.ts`, any test file.
   - Refactor ≥1 V2 tool (e.g., `run-research`) to call `researchPhase` directly. Validate via existing orchestrator tests.
   - ~1-2 weeks.

3. **Decide later, based on data**
   - [QUA-557](https://linear.app/quantifieduncertainty/issue/QUA-557) tracks the required benchmark: 5 pages × 2 engines, auto-scored + blind qualitative review, ~\$40-80 budget. Completing this audit gates Options B and C. Running it without the methodology spec'd in QUA-557 would produce impressions, not data — the same failure mode that produced the informal "V2 did better" belief.

### What NOT to do

- **Don't migrate auto-update to V2 (agent) without parity data.** V2 costs Opus-per-orchestration-loop; auto-update runs daily on ~50+ pages; this could blow the $50/run budget on day one.
- **Don't delete V2.** It's feature-complete and actively supported; some users invoke it. Its batch mode has a legitimate niche even if auto-update didn't adopt it.
- **Don't rename only `page-improver/` without also updating the CLI flag.** Half-rename is worse than no rename.

---

## 9. Decision-critical unknowns (block later options, not the recommendation)

1. **Cost per page: V1 (Sonnet-only) vs V2 (Opus + Sonnet).** No data. Required before Option B.
2. **Quality delta: V1 vs V2 on identical pages.** No data. Required before Options B or C.
3. **Does V2's `batch-runner.ts` handle multi-page Batch-API runs the way auto-update needs?** Auto-update's comment explicitly says tool use doesn't work in Batch API; V2 uses tools. This may mean V2's batch mode is architecturally incompatible with auto-update's daily workload — worth a design note before assuming Option B is even feasible.
4. **What breaks if auto-update's imports from `page-improver/utils.ts` change path?** Trivial to verify, but the import set is wide (14 symbols) — a dedicated follow-up should enumerate.

---

## 10. Reproducible verification

All claims in this doc can be regenerated:

```bash
# File inventory & LOC
find crux/authoring/page-improver -name '*.ts' ! -name '*.test.ts' | xargs wc -l | tail -1
find crux/authoring/orchestrator -name '*.ts' ! -name '*.test.ts' | xargs wc -l | tail -1

# V1 phase count
ls crux/authoring/page-improver/phases/*.ts | grep -v '\.test\.' | grep -vE '(index|prompts|json-parsing)\.ts$' | wc -l

# V2 tool count (exclude registry/index/types/metrics)
ls crux/authoring/orchestrator/tools/ | grep -vE '^(index|registry|types|metrics)\.ts$' | wc -l

# Every --engine invocation in CI + code
grep -rn "\-\-engine" .github/ crux/ scripts/ 2>/dev/null | grep -v node_modules

# V2 imports from V1
grep -rn "from '.*page-improver" crux/authoring/orchestrator/ crux/authoring/page-review.ts crux/authoring/batch-runner.ts

# Auto-update imports from V1
grep -n "from.*page-improver" crux/auto-update/*.ts

# Any test comparing V1 and V2 on the same page
grep -rn "v1.*v2\|compare.*engine" crux/authoring/**/*.test.ts
```

---

## 11. Related work

- **QUA-323** — Umbrella: all content-authoring paths must produce resource-backed citations. Touches both engines; would be simplified by phase extraction (one place to enforce instead of two).
- **QUA-529** — Validator orchestrator audit. Different orchestrators (gate.ts, data.ts, daily.ts, unified.ts) — this audit is NOT about those.
- **QUA-408** — Data-model unwind epic. Same spirit of "unwind accidental complexity" but different subsystem.
- `docs/agent-rules/auto-update-system.md` — auto-update consumer documentation; should be updated after the rename in PR 1.
- `content/docs/internal/data-architecture-overview.mdx:320-335` — user-facing engine docs; primary target for PR 1 rename.

---

## 12. Follow-up tickets

- **[QUA-557](https://linear.app/quantifieduncertainty/issue/QUA-557)** — V1 vs V2 quality benchmark (**filed**). Unblocks Options B and C. ~\$40-80, ~2-3h of human review.
- **Rename pass** (Option D slice) — small PR, ~1-2 days. Not yet filed; wait for audit sign-off.
- **Phase extraction** (Option A slice) — medium PR, ~1-2 weeks. Not yet filed; wait for audit sign-off.
- **Auto-update batch reconciliation** — should auto-update's custom Batch-API wrapper be moved to `lib/anthropic-batch.ts` for reuse? (Already lives there — check whether V2's batch-runner could use it.) Not yet filed.

# Deletion Catalog — longterm-wiki

*2026-06-09. Three deletion-only agents with mechanical reachability verification (grep all entry points: crux.mjs registrations, groups.ts, workflows, skills/hooks/rules, package.json scripts, app code, MDX usage). Control test passed: `crux/worker/` (previously misflagged dead, actually live) was correctly detected as referenced.*

**Execution umbrella**: [QUA-1163](https://linear.app/quantifieduncertainty/issue/QUA-1163)

**Totals: ~17,400 LOC of code certainly deletable now + ~2,500 LOC after one-line deregistrations + ~5.5 MB assets/docs. Plus ~5K LOC freezable.**

Companions: [`./2026-06-09-deep-review.md`](./2026-06-09-deep-review.md), [`../plans/refactor-portfolio-2026-06.md`](../plans/refactor-portfolio-2026-06.md).

## ⚠️ Corrections to prior kill lists (verified LIVE — do not delete)

The 2026-04-27 audit and ADR-0001/0003 dispositions contain stale claims (~7,800 LOC):

- **4 of the 5 "ADR-0003 orphan validators" are alive**: `validate-financials` + `validate-quality` imported by `crux/qa-sweep/sweep.ts:48-49` and registered in commands/validate.ts; `validate-hallucination-risk` is a library for `crux/auto-update/ci-risk-scores.ts:21`; `validate-consistency` powers the registered `verify-consistency` domain. Only **`validate-sourcing-names.ts`** is mechanically orphaned. → Annotate ADR-0003's disposition list as stale.
- **`crux/pr-review/` (898 LOC) is live** — invoked by `docs/agent-workflows/agent-review-pr.md:183`, the canonical body of the enforced `/agent-review-pr` skill.
- **`crux/entity-matrix/` core (~2,276 LOC) is live** — `generate.ts` spawned by `apps/web/scripts/lib/output-writer.mjs:311` ← `build-data.mjs:1351` ← prebuild/CI. Only `scan.ts` + `gaps.ts` are dead.
- **Most "one-shot import/backfill domains" are recurring pipelines**: setup-org, clean-contradicted (imported by sourcing-orchestrate.ts:26), import-grants/import-scorecards/import-divisions/import-funding-programs (live ingestion factories), backfill-grantee-ids/backfill-program-ids (recurring post-import maintenance).
- Live scripts misflagged: `crux/scripts/refresh-frameworks.ts` (refresh-frameworks.yml), `check-pr-merge-eligible.ts` (.claude/hooks/require-stage-approved.sh:20).
- **LLM client layers: none deletable** (importer counts: anthropic 44, llm 65, claude-cli 7, openrouter 5).

## Batch 1 — Repo junk, zero code risk (~5.5 MB)

| Item | Size | Notes |
|---|---|---|
| Root screenshots: `provisions-collapsed.png`, `provisions-expanded-v3.png`, `provisions-tab.png`, `talent-flows-v1.png` | 556 KB | Zero refs; untouched since 2026-02-09 |
| Root `public/llms*.txt` (3 files) | 12 KB | Stale output of a generator that actually writes to `apps/web/public` (gitignored there); root `public/` is served by nothing. Removes the whole root `public/` dir |
| `.pr-body.md`, `.tablebase-org-notes.yaml` | 18 KB | One-shot leftovers, zero refs. (KEEP `.tablebase-completed.txt` — read by `crux/tablebase/task-ranker.ts:16`) |
| `.claude/session-log.md`, `.claude/sessions/` (7 tracked files), `.claude/review-done` (git rm --cached), `.claude/reviews/`, `.claude/enrichment-test-results-2026-03-22.md` | ~58 KB | Session logs are PG-stored per `.claude/rules/session-logging.md`; sessions/ is gitignored but these predate the ignore |
| `.claude/plans/` (all 5), `.claude/design/kb-migration-plan.md` + `kb-library.md` | ~104 KB | One-time plans + design docs for the removed `packages/kb` |
| `.claude/skills/admin-setup/` + `.agents/skills/admin-setup/` | 24 KB | Superseded by /setup-slot-orchestration + /setup-releases |
| `data/pending-personnel-apart-research.json`, `data/page-forecasts.yaml` (generator no longer exists), `data/political-tracking-resources.yaml` | 28 KB | Zero refs each |
| `todo/` (README + 006) | 8 KB | Tasks 001–005 done per own README; file 006 in Linear first if still wanted |
| `apps/web/public/images/internal/master-graph-expanded.png`, `master-graph-interactive.png` | 168 KB | Only refs are stale .claude/plans docs (also deleted). KEEP siblings dagitty-interface.png, loopy-interface.png (used by causal-diagram-visualization.mdx:346,360) |
| `.github/workflows/sync-data.yml` | 51 lines | Functionally inert: its inputs (.claude/sessions/*.yaml, data/auto-update/runs/) are gitignored — a CI checkout has nothing to sync |
| `.github/{pr-assets,pr-screenshots,screenshots}/` (21 PNGs) | 4.1 MB | Zero in-repo refs. Caveat: old PR descriptions embedding via main-branch raw URLs lose images (SHA-pinned survive) |
| `.mcp.json` | 194 B | Tracked despite gitignored; `git rm --cached` or drop the ignore line |

## Batch 2 — crux/scripts + repo-root scripts one-shots (~8,700 LOC)

All zero-ref, last touch Feb–Apr 2026. crux/scripts/ (30 files, 7,740 LOC):

seed-fisa-702.ts (782) · fix-contradicted-facts.ts+test (674+486; superseded by sourcing-resolve-contradicted) · fix-resource-titles.ts+test+resource-title-fixes.json (388+163+1,113) · backfill-fact-entity-ids.ts (293) · triage-footnotes.ts (276) · migrate-kb-slugs-to-stableids.ts (269) · normalize-stableids.ts+stableid-migration-map.json (249+87) · wire-references.ts (232) · dedup-resources.ts (227) · sync-careers-to-personnel.ts (221) · migrate-naked-fact-ids.ts (219) · recompute-source-verdicts.ts (217) · grokipedia-from-wikipedia.mjs (217) · migrate-resource-hex-to-stableid.ts (209) · cleanup-personnel.ts (176) · seed-fisa-702-analyze.ts (164) · fix-url-resource-titles.ts (150) · apply-batches-to-fisa-702.ts (148) · check-source-urls.ts (133) · fetch-forum-posts.ts (117) · strip-career-facts.ts (109) · migrate-entity-types.mjs (108) · add-stableids-to-entity-yaml.ts (100) · verify-grokipedia-links.mjs (100) · migrate-ref-slugs.ts (85) · research-fisa-702.ts (28)

Repo-root scripts/ (4 files, 974 LOC): add-people-batch.ts (453) · backfill-resource-summaries.ts (208) · normalize-related-entities.mjs (162) · backfill-archive-urls.ts (151)

Needs-one-check: qua-503-generate-mapping.ts (413) + qua-503-sweep-mdx.ts (121) — deletable once the qua-503 prod rewrite is confirmed applied; scrape-ailabwatch.ts (208+test) — confirm the ailabwatch source is retired (feeds live import-scorecards).

## Batch 3 — crux lib orphans (~5,900 LOC)

`crux/calibration/` whole dir (1,055 + metrics.json; only refs are prose + .gitignore lines) · `crux/entity-matrix/scan.ts` (162) + `gaps.ts` (147) — standalone CLIs, zero invokers.

Zero-importer lib files (25, all verified; last-touch dates from git):

| Path | LOC | Note |
|---|---|---|
| lib/validation/mermaid-checks.ts | 604 | "mermaid" hits elsewhere are unrelated |
| authoring/reassign-update-frequency.ts | 505 | |
| lib/issue-scoring.ts + test | 447+487 | only its own test imports it |
| lib/matrix-snapshot.ts + test | 259+343 | test-only |
| lib/matrix-dimensions.ts + test | 329+91 | test-only |
| authoring/bootstrap-update-frequency.ts | 228 | |
| wiki-server/sync-things.ts | 228 | UNREACHABLE: docs claim a CLI dispatch that doesn't exist in commands/wiki-server.ts |
| lib/content/section-writer-live-test.mts | 190 | manual harness |
| lib/calc-evaluator.ts | 186 | |
| lib/normalize-entity-slugs.ts | 159 | |
| lib/wiki-server/model-aliases.ts | 77 | NAME-COLLISION TRAP: all grep hits are the identically-named route |
| lib/wiki-server/benchmark-results-pending.ts | 71 | same trap |
| authoring/orchestrator/tools/add-references.ts | 54 | not in tool registry; v1 leftover |
| lib/dispatch-prompt-template.ts | 48 | |
| lib/issues/index.ts, lib/political/index.ts, lib/maintain/index.ts | 37+37+33 | dead barrels (siblings imported directly) |
| health-monitor/index.ts | 21 | daemon.ts/types.ts imported directly |
| generate/generate-research-reports.ts | 20 | |
| evals/injectors/index.ts | 18 | |
| lib/entity-names.ts | 17 | |
| authoring/creator/index.ts | 15 | dead barrel |
| check-links.ts | 9 | back-compat shim, zero refs |
| commands/factbase-migrate-records.ts + test | 35+17 | not registered anywhere |
| validate/crux-tsc-baseline.txt | 1 | zero code reads it (the QUA-636 phantom) |

## Batch 4 — apps/web + packages (~2,400 LOC + 3 deps)

Whole files (zero refs, certain):

| Path | LOC |
|---|---|
| components/internal/FactDashboard.tsx | 954 |
| app/legislation/[slug]/resource-timeline.tsx | 377 |
| app/people/[slug]/social-links.tsx | 113 |
| app/legislation/[slug]/stakeholder-detail.tsx | 104 |
| components/wiki/CauseEffectGraph/components/DetailsPanel.tsx (+1 barrel line) | 101 |
| app/data-sources/data-sources-tab-content.tsx | 94 |
| app/organizations/[slug]/related-orgs-section.tsx | 86 |
| app/divisions/[slug]/division-shared.tsx | 45 (exports shadowed by live copies in record-detail-ui.tsx + grant-shared.tsx) |
| components/wiki/factbase/index.ts (dead barrel incl. 8 KB* aliases) | 18 |
| packages/factbase/src/types.ts `FactOnlyFile` interface | ~15 |

MDX registrations (verified with word-boundary patterns after naive patterns false-positived):
- **30 of 38 stub names dead** (mdx-components.tsx:129-144): DataCrux, DualOutcomeChart, EntityGraph, FactorAttributionMatrix, FactorGauges, FullModelDiagram, ImpactGrid, InsightGridExperiments, InsightScoreMatrix, KnowledgeTreemap, OutcomesTable, PageIndex, PixelDensityMap, PriorityMatrix, QualityDashboard, ResearchFrontier, ResourceCite, RiskDashboard, RiskTrajectoryExperiments, RootFactorsTable, ScenariosTable, SparseKnowledgeGrid, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TopicQuestionGrid, TrajectoryLines. **8 survivors must stay**: AnthropicFact, ArticleSources, ConceptsDirectory, DataEstimateBox, EstimateBox, InsightsTable, TagBrowser, TimelineViz.
- 10 dead `KB*` alias lines (:207-215) + VerificationStatus long-form (:219).

Deps (apps/web/package.json): `@radix-ui/react-select`, `@radix-ui/react-toggle`, `@radix-ui/react-toggle-group` — zero imports, no corresponding ui/ files. (dotenv in discord-bot looked dead but is used via bare `import "dotenv/config"` — keep.)

## Batch 5 — after one small change each (~2,500 LOC)

| Item | LOC | The change needed first |
|---|---|---|
| commands/migrate-citations.ts | 352 | remove crux.mjs:111,225 + groups.ts:87 |
| commands/factbase-migrate.ts | 431 | remove import + wiring in commands/factbase.ts:19 |
| commands/factbase-migrate-entities.ts + test | 237+366 | crux.mjs:100,213 + factbase.ts:25 + crux.bash |
| commands/backfill-yaml-stable-ids.ts | 242 | crux.mjs:98,211 + tablebase.ts:28,1517 + crux.bash |
| commands/import-quri-personnel.ts | 199 | crux.mjs:92,205 |
| commands/strip-scores.ts | 177 | 4-line entry in commands/content.ts:64-66 |
| validate/validate-sourcing-names.ts | 164 | drop line 54 of validate-sourcing-lint-guard SKIP_FILENAMES |
| components/wiki/PageCauseEffectGraph.tsx | 231 | remove mdx-components import (L17) + registration (L185) |
| components/political/finance-cell.tsx | 175 | remove 2 export lines from political/index.ts |
| components/directory/EntityLink.tsx (DirectoryEntityLink) | 41 | remove barrel export line 6 |
| MultiEntityLinks (in wiki/EntityLink.tsx:151-170) | 20 | mdx-components L2,155 + crux/lib/rules/component-imports.ts:18 |
| `KBF: FBF` alias (mdx-components:160) | 1 | FIRST update crux authoring prompts that instruct LLMs to emit `<KBF>`: crux/authoring/creator/synthesis.ts:278,284-285 + orchestrator/scaffold.ts:94 + tests |
| data/claims-properties.yaml | 20 KB | superseded by packages/factbase/data/properties.yaml; update stale comment at FBCellValue.tsx:34 |
| 3 dead-subject internal docs: anthropic-pages-refactor-notes.mdx, gap-analysis-2026-02.mdx, server-communication-investigation.md | ~25 KB | remove wiki-nav.ts entries :339,:353,:381; check suggested-pages-content.tsx + reader-importance/research-ranking yaml entries |

## Freezable / needs-human-call

- `crux/evals/` (3,541 LOC, last touch 2026-04-11): registered domain + docs only, zero workflow/skill/hook invocations. Freeze or delete (needs crux.mjs+groups+docs edits).
- `grokipedia` command (280 LOC, 2026-03-19): same profile.
- `commands/issues.ts` (1,409 LOC): superseded by Linear (QUA-365) but still wired into 3 skills (.claude/commands/agent-next-issue.md, plan-feature.md, score-issues.md) — trim write paths only after retiring those skills.
- Workflows: `resolve-conflicts.yml` + script (last run 2026-03-02; superseded by PR patrol? human call) · `auto-update.yml` / `refresh-frameworks.yml` (deliberately paused, QUA-31 decision) · `wikidata-enrich.yml` (keep, manual utility).
- `.claude/scripts/` launchd cron pair (10 KB): not installed on this machine (`launchctl list` shows only com.qu.lw-fix-tabs); dead if no other machine runs them.
- `.claude/design/anthropic-ontology.md` (50 KB) + `statements-strategy.md` (97 KB): zero refs but statements is live — may be intentional design context.
- `docs/benchmarks/qua-476/` (~80 KB): zero refs (qua-506 IS cited by migrations 0181/0190 — keep that one).
- `docs/migrations/qua-497-fact-id-mapping.json`: imported by migrate-naked-fact-ids.ts — delete together once migration confirmed complete.
- Discussions-era skills (update-discussion, work-on-discussion, score-issues): delete when GitHub Discussions formally retired.
- `data/removed-content.yaml`: claims to be a "do not recreate" guard — **nothing reads it**. Implement (ticket) or delete; currently false comfort.
- `apps/web/scripts/audit-naked-ids.mjs` (362): manual regression check "until the e2e spec is fixed" — check QUA-537 landed first.
- `audit-naked-ids` note aside, e2e specs all target live routes; conditional test.skips are data-dependent, not stale.
- QUA-1150 enumeration: the 11 internal docs with stale `packages/kb/data/things` refs (coverage-guide, fact-system-strategy, content-database, canonical-facts, architecture, structured-data-architecture, citation-architecture, wiki-generation-architecture, content-pipeline-architecture, knowledge-graph-ontology, data-system-authority) need ref **updates**, not deletion.

## Execution notes

Five PRs in batch order; each independently revertible; each carries its grep evidence in the PR body; batches 2–4 run the full gate + a prod build as the safety net. Re-verify any item against current HEAD before deleting (these verdicts are as of 2026-06-09, commit 4ed3c99ae). Annotate ADR-0003's stale orphan list and the 2026-04-27 audit doc as part of Batch 3's PR.

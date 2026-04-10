# Source-Check / Verdict / Coverage System

Subsystem map for source-checking, verdict tracking, and entity coverage scoring. **Read this before proposing new verdict UI, coverage scores, or source-check endpoints** — most of the plumbing already exists.

## Why this file exists

Agents have repeatedly proposed "add a coverage/source-check score column to X" without realizing the components, APIs, and scoring functions already exist and are embedded on public pages. The naming doesn't follow "source-check" — look for "claims", "verdict", "coverage", "dot", "pipeline".

---

## 1. Database tables

- `source_check_evidence` (schema.ts:1657) — per-source checks. 5 verdict types: `confirmed | contradicted | unverifiable | outdated | partial`. Links to `resourceId` and `sourceUrl`. Field-level granularity via `field_name` (NULL = row-level).
- `source_check_verdicts` (schema.ts:1703) — aggregate verdict per `(record_type, record_id, COALESCE(field_name, ''))`. 6 states: adds `unchecked`. Derived from evidence rows.
- **Migration**: `0127` unified the legacy `record_verifications` + `record_verdicts` + `factbase_resource_verifications` + `factbase_verdicts` into these two tables. Don't create new verdict tables.
- `things.verdict` — removed. Verdicts now live only in `source_check_verdicts`.

## 2. Wiki-server endpoints (`/api/source-checks/*`)

All in `apps/wiki-server/src/routes/source-check/source-checks.ts`, mounted in `app.ts:203`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/verdicts` | Query verdicts by entity/record/verdict type |
| GET | `/verdicts/:recordType/:recordId` | Single record's verdicts |
| POST | `/verdicts` | Upsert aggregate verdicts |
| POST | `/evidence` | Ingest per-source evidence |
| GET | `/stale-evidence` | Checks needing rerun (model drift) |
| GET | `/due-for-recheck` | Records needing rechecking |
| GET | `/coverage` | Table coverage summary |
| GET | `/coverage-matrix` | Record type × coverage cross-tab |
| GET | `/verdict-matrix` | Record type × verdict cross-tab |
| GET | `/entity-summary` | Entity-level stats |
| GET | `/resolve-names` | recordIds → display names |

**Frontend proxies** (`apps/web/src/app/api/*-proxy/`): `claims-by-entity-proxy`, `source-check-verdicts-proxy`, `source-check-coverage-proxy`, `source-check-names-proxy`, `source-check-detail`, `entity-profile-proxy`. Use these from server components; don't add new proxies without checking.

## 3. React components (the critical section — the miss point)

**Visual indicators** (already embedded in directory tables and profile pages):
- `components/coverage/CoverageDots.tsx` — pie-chart 1-4 score indicator
- `components/coverage/RecordStatusDots.tsx` — **CoverageDots + SourceCheckDot combined**. This is the thing agents keep missing.
- `components/source-check/SourceCheckDot.tsx` — unified colored dot, 5 states: `not_run | error | failed | trouble | verified`
- `components/source-check/FactSourceCheckDot.tsx` — fact variant
- `components/wiki/VerdictBadge.tsx` — wiki citation verdict
- `components/wiki/ReferenceCitationDot.tsx` — citation accuracy dot

**Data display components:**
- `components/entity/claims-pipeline-summary.tsx` — `ClaimsPipelineSummary`: fetches `/api/claims-by-entity-proxy`, renders pipeline flow (sources → claims → records)
- `components/directory/EntityDbPage.tsx` — `EntityDbPage`: wrapper using EntityProfileViewer
- `app/internal/entity-profile/entity-profile-viewer.tsx` — `EntityProfileViewer`: core database record browser, renders SourceCheckDot inline

## 4. Coverage computation

- `components/coverage/coverage-score.ts` — **12 entity-type scorers**, all return 1–4: `computeOrgCoverage`, `computePersonCoverage`, `computeAiModelCoverage`, `computeLegislationCoverage`, `computeProjectCoverage`, `computeBenchmarkCoverage`, `computeGrantCoverage`, `computeFundingProgramCoverage`, `computeFundingRoundCoverage`, `computeDivisionCoverage`, `computePublicationCoverage`, `computeGenericCoverage`. Also signal extractors: `getOrgSignals`, `getPersonSignals`, `getLegislationSignals`.
- `data/entity-coverage.ts` — `getEntityDataDepth()`, `computeEntityCoverage()` (dispatches to type scorers), `getAllEntityCoverageScores()` (batch, for dashboards)
- `data/page-coverage.ts` — `getPageCoverageItems()` (wiki page coverage from database.json)
- `lib/coverage.ts` — `getRatioStatus(num, denom)` (≥75% green, >0 amber, 0 red), `getMetricStatus(actual, target)`

**Adding coverage for a new entity type**: add a scorer in `coverage-score.ts` + dispatch it in `data/entity-coverage.ts::computeEntityCoverage()`. Don't create a parallel scoring system.

## 5. Public surfaces already rendering source-check data

- `/organizations/:slug` profile — RecordStatusDots in sub-section tables
- `/organizations/:slug/data` — EntityDbPage → EntityProfileViewer
- `/organizations` directory table — RecordStatusDots per row
- `/people`, `/people/:slug/db`, similar pattern for persons
- `/approaches`, `/benchmarks`, `/projects`, `/ai-models` directories — RecordStatusDots import in `*-table.tsx` files
- Entity profile headers — ClaimsPipelineSummary

If you're about to add a "show source-check status on X page", first grep for `RecordStatusDots` / `SourceCheckDot` / `CoverageDots` imports — it may already be there.

## 6. Internal dashboards

- **Source Checks** (E2200) — `/internal/entity-source-checks/` — main dashboard. Subcomponents: `action-queue.tsx`, `claims-viewer.tsx`, `coverage-bars.tsx`, `source-check-tabs.tsx`
- **Source Check Coverage** — `/internal/source-check-coverage/` — loads `/api/source-checks/stats`, coverage-matrix, verdict-matrix
- **Citation Accuracy** (E917) — `/internal/citation-accuracy/`
- **Data Quality** (E2600) — `/internal/data-quality/`
- **People Coverage** (E1099) — entity coverage scores for people

## 7. Conventions

- **Entity coverage scale**: 1=stub, 2=basic, 3=moderate, 4=comprehensive. Typical record is 2, not 3.
- **Source-check verdict states** (6): `confirmed | contradicted | outdated | partial | unverifiable | unchecked`
- **Citation verdict states** (5): `accurate | minor_issues | inaccurate | unsupported | not_verifiable`
- **Unified display status** (5): `not_run | error | failed | trouble | verified`. Mapping in `recordVerdictToStatus()` / `factbaseVerdictToStatus()` at `source-check-status.ts:65-105`.
- **Color scheme**: canonical source is `components/shared/verdict-styles.ts` — `SOURCE_CHECK_VERDICT_STYLES`, `CITATION_VERDICT_STYLES`, `CITATION_VERDICT_COLORS`, `SOURCE_CHECK_VERDICT_PRIORITY`, `CITATION_VERDICT_SEVERITY`. **Do not inline your own color map** — `source-check-coverage-content.tsx` did this at lines 51-67 and it's a known duplication.
- **Checker model**: `claude-haiku-4-5-20251001` (source-checks.ts:66). Stale model → rerun flagged.
- **Build-time vs runtime**: entity coverage is computed on-demand from database.json + FactBase KB. Source-check verdicts/evidence are runtime PG queries.

## 8. Known rough edges (don't re-discover these)

- `SourceCheckDot` accepts `href` but not all callers pass it — personnel/grants tables may not link through.
- Two parallel scoring systems: entity coverage (type scorers) vs page coverage (database.json green/amber/red). No single "data completeness" score.
- Per-field verdicts are stored (`source_check_verdicts.field_name`) but `EntityProfileViewer` aggregates by record, not field. Public tables don't show per-field granularity.
- Color-map duplication: `source-check-coverage-content.tsx:51-67` redefines verdict colors independently of `verdict-styles.ts`.
- Coverage ratio thresholds hardcoded at 75% in `lib/coverage.ts:17`.
- No automatic entity-level verdict aggregation ("entity has contradicted info") — only per-record.

## Adding new functionality — checklist

Before proposing new work in this subsystem:

1. **Grep `RecordStatusDots`, `SourceCheckDot`, `CoverageDots`, `computeXxxCoverage`** — the thing may already exist
2. If adding a new entity type's coverage score: add scorer to `coverage-score.ts`, dispatch in `entity-coverage.ts`. Don't copy the pattern to a new file.
3. If adding a new verdict type: update `source-check-status.ts` mapping AND `verdict-styles.ts` — both must stay in sync
4. If adding a dashboard: use `/internal/entity-source-checks/` as the Pattern A reference; it has entity ID + redirect already wired

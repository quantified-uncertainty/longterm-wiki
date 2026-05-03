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

## 2. Wiki-server endpoints (`/api/sourcing/*`)

All in `apps/wiki-server/src/routes/sourcing/sourcing.ts`, mounted in `app.ts`. The legacy `/api/source-checks/*` path is kept as a backward-compat alias.

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
- `apps/web/src/lib/coverage.ts` — `getRatioStatus(num, denom)` (≥75% green, >0 amber, 0 red), `getMetricStatus(actual, target)`

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
- **Source Check Coverage** — `/internal/source-check-coverage/` — loads `/api/sourcing/stats`, coverage-matrix, verdict-matrix
- **Citation Accuracy** (E917) — `/internal/citation-accuracy/`
- **Data Quality** (E2600) — `/internal/data-quality/`
- **People Coverage** (E1099) — entity coverage scores for people

## 6a. Content-change detection — the re-classify-on-fetch flow (QUA-312 / QUA-329)

When a resource's underlying content changes upstream, source-check verdicts that were generated against the old content are no longer trustworthy. The pipeline detects this automatically via a content hash:

1. **Persist** — `crux/lib/job-handlers/resource-ingest.ts` computes a SHA-256 (first 16 hex) of the freshly-fetched content and writes it to `resources.content_hash` via `PATCH /api/resources/:id/fetch-status` (QUA-329).
2. **Surface** — list / suggest endpoints return `contentHash` so callers enqueueing re-ingest jobs can pass it as `previousContentHash`.
3. **Compare** — on the next ingest, `resource-ingest` compares the freshly-computed hash to `previousContentHash` and sets `contentChanged: true` when they differ.
4. **Bypass skip-guard** — `resource-enrich` normally skips already-enriched resources, but `contentChanged: true` bypasses that guard so enrichment re-runs on the new content (QUA-312 Phase 2).
5. **Re-classify** — re-enrichment cascades into a fresh source-check verdict against the updated content. Stale verdicts get refreshed; previously-confirmed verdicts that no longer hold flip to `contradicted` / `outdated`.

**Production callers passing `previousContentHash`** (QUA-329):
- `crux/commands/jobs.ts` `enqueueResourceReingest` (the `crux sys jobs enqueue-resource-reingest` periodic loop)
- `apps/wiki-server/src/routes/wikibase/resources.ts` `POST /api/resources/suggest` (the claims-pipeline batch enqueue)

**Callers that intentionally omit it** — these enqueue jobs for resources with no prior fetch (no hash to compare against):
- `crux/commands/jobs.ts` `enqueueResourceIngest` — filters for `lastFetchedAt === null`
- `crux/lib/sourcing/source-fetcher.ts` (cache-miss self-healing path) — URL has never been seen
- `crux/commands/sourcing-orchestrate.ts` — uncached URLs only

**Don't bypass the hash for re-fetches.** Skipping `previousContentHash` from a caller that has access to the prior hash silently disables QUA-312's temporal fix — the enrich skip-guard will block re-enrichment even on changed content. Test coverage: `crux/lib/job-handlers/__tests__/resource-ingest.test.ts` "round-trips contentHash from ingest #1 to previousContentHash on ingest #2".

## 7. Conventions

- **Entity coverage scale**: 1=stub, 2=basic, 3=moderate, 4=comprehensive. Typical record is 2, not 3.
- **Source-check verdict states** (6): `confirmed | contradicted | outdated | partial | unverifiable | unchecked`
- **Citation verdict states** (5): `accurate | minor_issues | inaccurate | unsupported | not_verifiable`
- **Unified display status** (5): `not_run | error | failed | trouble | verified`. Mapping in `recordVerdictToStatus()` / `factbaseVerdictToStatus()` at `apps/web/src/components/source-check/source-check-status.ts`.
- **Color scheme**: canonical source is `components/shared/verdict-styles.ts` — `SOURCE_CHECK_VERDICT_STYLES`, `CITATION_VERDICT_STYLES`, `CITATION_VERDICT_COLORS`, `SOURCE_CHECK_VERDICT_PRIORITY`, `CITATION_VERDICT_SEVERITY`. **Do not inline your own color map** — `source-check-coverage-content.tsx` did this at lines 51-67 and it's a known duplication.
- **Checker model**: `claude-haiku-4-5-20251001` (source-checks.ts:66). Stale model → rerun flagged.
- **Build-time vs runtime**: entity coverage is computed on-demand from database.json + FactBase KB. Source-check verdicts/evidence are runtime PG queries.

## 8. Known rough edges (don't re-discover these)

- `SourceCheckDot` accepts `href` but not all callers pass it — personnel/grants tables may not link through.
- Two parallel scoring systems: entity coverage (type scorers) vs page coverage (database.json green/amber/red). No single "data completeness" score.
- Per-field verdicts are stored (`source_check_verdicts.field_name`) but `EntityProfileViewer` aggregates by record, not field. Public tables don't show per-field granularity.
- Color-map duplication: `source-check-coverage-content.tsx:51-67` redefines verdict colors independently of `verdict-styles.ts`.
- Coverage ratio thresholds hardcoded at 75% in `apps/web/src/lib/coverage.ts::getRatioStatus`.
- No automatic entity-level verdict aggregation ("entity has contradicted info") — only per-record.

## Adding new functionality — checklist

Before proposing new work in this subsystem:

1. **Grep `RecordStatusDots`, `SourceCheckDot`, `CoverageDots`, `computeXxxCoverage`** — the thing may already exist
2. If adding a new entity type's coverage score: add scorer to `coverage-score.ts`, dispatch in `entity-coverage.ts`. Don't copy the pattern to a new file.
3. If adding a new verdict type: update `source-check-status.ts` mapping AND `verdict-styles.ts` — both must stay in sync
4. If adding a dashboard: use `/internal/entity-source-checks/` as the Pattern A reference; it has entity ID + redirect already wired

## 9. PDF resources & page-addressable evidence (QUA-942)

PDFs (safety reports, scorecards, methodology docs) get archived through the
**`archivePdfResource()` adapter** — `crux/lib/resource-archive/pdf.ts`. Don't
roll your own "fetch + extract + insert resource" pipeline; this adapter is the
shared seam.

**What it does in one call:**

1. Loads the binary (HTTPS fetch with SSRF guard, or accepts a pre-fetched
   buffer / local file path).
2. Computes a full SHA-256 over the **binary** — this is the deterministic
   integrity hash that survives `pdf-parse` upgrades and rendering changes.
3. Extracts text + Info-dictionary metadata (`pageCount`, `title`, `author`,
   `creationDate`) via `extractPdfMetadata` (also exported from `pdf-extractor.ts`).
4. Upserts a `resources` row (`type='paper'`, `resourcePurpose='primary_source'`,
   `resourceSubtype='pdf_report'`, `contentLifecycle='immutable'` by default).
5. Posts a snapshot to `resource_content_versions` via
   `POST /api/resources/:id/content-versions` with the binary hash, extracted
   text, and PDF metadata in `metadata` JSONB.
6. Returns `{ resourceStableId, contentHash, pageCount, fromCache }`.

**Schema choice (Phase 1):** PDFs do **not** get a parallel `resource_documents`
parent table. They use the existing `resources` row + `resource_content_versions`
with `content_type='application/pdf'`. PDF-specific metadata lives in
`resource_content_versions.metadata` JSONB. This keeps the surface area small;
revisit if a future requirement (e.g. table-of-contents JSON, per-table extracts)
demands typed columns.

**Storage policy:** the binary itself is **not** stored in PG. The hash + size
are persisted; the canonical binary lives at `data/scorecards/raw/<source>/<wave>/report.pdf`
(committed to git) with `resources.local_filename` pointing back to it. If
upstream rots, the committed copy + matching hash is the ground-truth archive.

**Page-addressable evidence:** `source_check_evidence.evidence_locator` (JSONB,
added in migration `0224`) carries one of three discriminated locator shapes
validated by `EvidenceLocatorSchema` in `sourcing.ts`:

```json
{ "kind": "pdf-page",   "page": 14, "table": "2.3" }
{ "kind": "csv-cell",   "row": 23, "column": "risk-assessment" }
{ "kind": "html-anchor", "selector": "#table-2" }
```

`evidence_locator IS NULL` = whole-source verdict (existing behavior; no
back-fill on existing rows). The column has a partial GIN index covering only
non-null rows so we don't pay storage for the millions of NULL legacy rows.

**Calling convention:**

```ts
import { archivePdfResource } from "../lib/resource-archive/pdf.ts";

const result = await archivePdfResource({
  url: "https://futureoflife.org/.../AI-Safety-Index-2024-Full-Report.pdf",
  localFilePath: "data/scorecards/raw/fli/2024-12/report.pdf", // optional
  publisherEntityId: "sid_FliEntity",
  contextNote: "FLI Dec 2024 wave report",
  tags: ["scorecard", "fli_index", "wave:2024-12"],
});

// Then attach evidence with a page locator:
await postEvidence({
  recordType: "scorecard_grade",
  recordId: gradeId,
  resourceId: result.resourceStableId,
  evidenceLocator: { kind: "pdf-page", page: 18 },
  verdict: "confirmed",
  // ...
});
```

**CLI:** `pnpm crux tb import-scorecards archive-pdf --source=fli_index --wave=2024-12`
is the proof-of-concept consumer; pattern is generalizable to any wave whose
PDF lives at `data/scorecards/raw/<source>/<wave>/report.pdf`.

**What's not in scope (file follow-up tickets):**
- OCR for image-only PDFs.
- Per-table-cell extraction inside PDFs (e.g., FMTI methodology appendix
  table 4 row 12). The `pdf-page` locator already supports `table` + `row`
  hints, but the actual extractor is per-source today.
- Migrating the system-card harvester (QUA-690) and citation pipeline to use
  this adapter. The adapter exists; the migration is a separate ticket.

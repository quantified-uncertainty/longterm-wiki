# Scorecard Upstream Archival + Deterministic Source-Check

**Status**: Design — not yet ticketed. Successor work to QUA-688 / QUA-864.
**Author**: Claude Code (this session, 2026-04-30).
**Reviewers**: TBD.
**Parent umbrella**: QUA-687 (AI safety data layer).
**Related shipped work (last 48h)**: QUA-839 (PR #4692) UI rendering layer; QUA-864 (PR #4734) LLM-against-live-URL verifier; QUA-942 (filed today) PDF resources adapter.

> **Read this doc with §12 (Critique + Revisions) open.** §12 lists factual errors, weak claims, and missing alternatives that surfaced in red-team passes after the body was drafted. The recommendation in §1 has been revised to match §12's findings; the rest of the body is preserved as written for transparency about how the design evolved.

---

## 1. Question this doc answers

> "Should scorecard waves archive their upstream CSV / HTML / PDF as Resources + content snapshots, the way grants already do, and run deterministic source-check against the archive?"

Short answer (revised post-critique): **partial yes.**

- **Phase 1 (archive upstream)**: high value, low risk. Closes link-rot and parser-regression auditability gaps. **Recommended.**
- **Phase 2 (deterministic evidence)**: marginal value at current LLM costs (~$2.50 for a full sweep of 5076 grades). Not blocked-on, can ship later. **Recommended only if Phase 1's snapshot integration justifies it as essentially-free incremental work.**
- **Phase 3 (drift detection)**: nice-to-have; defer until link rot or a parser regression actually bites.

Architecturally we should **follow the grants precedent** (`crux/lib/grant-import/snapshot-capture.ts` + `crux/lib/sourcing/deterministic-matcher.ts`) rather than invent a new path. See §12 for the corrected design.

---

## 2. Background — what already exists

### 2.1 Scorecard data model (QUA-688, QUA-697, QUA-698)

- `scorecard_snapshots` — one row per wave (`fmti-dec-2025`, `fli-summer-2025`, ...). Columns: `id`, `scorecardSource`, `waveLabel`, `publishedAt`, `sourceUrl`, `methodologyUrl`, `license`, `orgCount`, `dimensionCount`, `isLatest`, `sourceActive`.
- `scorecard_grades` — one row per (snapshot, entity, dimension). Columns: `id` (composite), `snapshotId`, `entityId`, `entityDisplayName`, `dimensionSlug`, `dimensionLabel`, `dimensionWeight`, `dimensionParentSlug`, `scoreNumeric`, `scoreLetter`, `scoreRaw`, `notes`, `sourceUrl` (per-cell deep-link, optional).
- 5 sources, 11 waves total in prod (verified Apr 30): FLI ×3, FMTI ×3, SaferAI ×1, AI Lab Watch ×1, Seoul ×1. ~5076 grade rows.

### 2.2 Two ingester families

| Family | Sources | Adapter shape | Upstream artifacts |
|---|---|---|---|
| **CSV-fetch (FMTI)** | `fmti` | `crux/lib/scorecards/fmti.ts` + `fmti-ingest.ts`: fetch CSV at run time from `raw.githubusercontent.com/stanford-crfm/fmti`. Pure transform → `ScorecardSnapshotRecord` + `ScorecardGradeRecord`. **Nothing committed to disk.** | 1–2 CSVs per wave, hosted on GitHub. |
| **Hand-curated extract (FLI/SaferAI/AILabWatch/Seoul)** | 4 sources | `crux/lib/scorecard-import/sources/<key>.ts`: read `data/scorecards/raw/<source>/<wave>/grades.json` (committed to repo). The `grades.json` is the parsed extract. Each adapter also has a sidecar (`page.html`, `report.pdf`, `comparison.html`, `index.html`) committed but **not registered as a resource**. | grades.json (extract) + 1 sidecar (HTML/PDF). |

Both families end at `POST /api/scorecard-snapshots/sync` + `/api/scorecard-grades/sync` and bypass the Resources system entirely.

### 2.3 Source-check shipped Apr 29-30

- **QUA-839 (PR #4692, 2026-04-29)** — UI rendering. `<SourceCheckDot>` reads `cell.sourcing?.verdict` from a LEFT JOIN against `source_check_verdicts`.
- **QUA-864 (PR #4734, 2026-04-30)** — verdict generation. Adds `scorecard_grade` to `VALID_RECORD_TYPES`, wires it through the existing orchestrator (`item-collectors.ts → record-descriptions.ts → fetchSourceContent → LLM → write evidence`). Each grade asserts "publisher X scored entity Y as Z on dimension D". The orchestrator falls back: `grade.sourceUrl ?? snapshot.sourceUrl`. Scoped to `latest=true` snapshots.

The orchestrator's source fetcher (`crux/lib/sourcing/source-fetcher.ts`) reads from `citation_content` (a hot cache, **overwritten** on each fetch) — not from `resource_content_versions` (append-only, content-hashed, temporal-deep). This matters and is one of the gaps below.

### 2.4 Resources / snapshots architecture

- `resources` — the catalog. Generic, content-type-agnostic. Stable IDs.
- `citation_content` — PK=url, **overwritten** on each fetch. The "what does this URL look like NOW" hot cache the orchestrator reads from.
- `resource_content_versions` (migration 0159) — append-only, content-hash dedup via `UNIQUE(url, content_hash)`. The TEMPORAL DEPTH layer. Comment in schema: *"Replaces the old split between citation_content (web pages, overwritten) and source_snapshots (tabular data, versioned). Both content types now go here."*
- `resource_tabular_sources` — schema metadata for structured sources. `dataFormat ∈ {csv, html_table, json_api, spreadsheet}`. PDFs not supported (QUA-942).
- `source_snapshots` — predates `resource_content_versions`; **still active for grants** (`crux/lib/grant-import/snapshot-capture.ts`). Same shape (raw text, content-hash, append-only).
- `resource-ingest` worker (`crux/lib/job-handlers/resource-ingest.ts`) — fetches a URL, computes content hash, writes both `citation_content` (latest) AND `resource_content_versions` (append-only). PDF text extraction via `pdf-parse` (`crux/lib/pdf-extractor.ts`). Idempotent on content_hash.

### 2.5 What `source_check_evidence` already supports

Schema is more capable than today's writers exercise:

```sql
record_type     -- 'scorecard_grade' (after QUA-864), 'grant', 'fact', ...
record_id       -- composite PK in source table
field_name      -- column-level granularity (NULL = whole row)
entity_id       -- the entity this is about (rolls up dots)
expected_value  -- what the record says
extracted_value -- what the source says
extracted_quote -- relevant passage
verdict         -- confirmed | contradicted | unverifiable | outdated | partial | not_applicable
confidence      -- 0..1
relevance_score -- QUA-791
is_primary_source
checker_model   -- 'haiku-4-5', 'inline-submission', 'scorecard-ingest@v1.0', ...
resource_id     -- FK to resources.stable_id
source_url
```

Every column needed for cell-level deterministic evidence is already present. Nothing in this proposal changes the evidence schema.

---

## 3. The gaps QUA-864 does not close

### Gap 1: link rot defeats verification permanently

The orchestrator reads from `citation_content` (overwritten). When `https://crfm.stanford.edu/fmti/October2023/` 404s next year — and it will, Stanford has moved /fmti/ once already — every Oct 2023 grade flips from `confirmed` to `unverifiable` and there is no archived ground truth to fall back on. Verdicts vanish for stale waves precisely when stable archival matters most.

### Gap 2: wave immutability is silently violated

A v1.0 (Oct 2023) grade is, by definition, "what Stanford published in Oct 2023". But the orchestrator hits the live URL today, which may now redirect to v1.2 (Dec 2025) content. The LLM may answer "yes confirmed" against the WRONG wave's content. Today this is masked because Stanford left the historical paths up — but it's a correctness foot-gun.

QUA-864 mitigates by scoping verdict generation to `latest=true` (line 365 of item-collectors.ts), but this means historical grades stay `unchecked` forever — the system has decided the cost-benefit, not realized the structural problem.

### Gap 3: deterministic claims pay LLM cost

For FMTI specifically, our adapter parses the CSV and **knows** Mistral's row N column M is `"1"`. Asking an LLM "did Stanford CRFM say Mistral scored 1 on indicator 23?" is a transcription check. The answer is provably the same as `extracted_value === scoreRaw`. 5076 grades × Haiku call × N re-checks is real money for a result we already have. The scorecards stack is uniquely-suited to deterministic evidence: every grade has a provenance chain ending in a literal cell.

### Gap 4: the existing tabular-archive path is not reused

Grants have solved this exact problem (`crux/lib/grant-import/snapshot-capture.ts`). For 14 grant data sources, the ingester:
1. Fetches the upstream CSV/HTML.
2. Computes content hash, writes a `source_snapshots` row.
3. Persists per-row records keyed on a parsed hash of the row content.
4. Source-check can verify against the archived snapshot.

Scorecards sidestep this. Adding scorecards to the same pattern is mostly wiring.

### Gap 5: no link from grade → archive

`scorecard_snapshots.sourceUrl` is a string, not an FK. Even when the upstream URL is alive, no row has a stable id pointing at "the version of that URL we ingested". Re-fetching can change content; we can't tell which fetch produced which grade rows.

### Gap 6: 4 of 5 sources have on-disk PDF/HTML sidecars that are nowhere in PG

`data/scorecards/raw/fli/2024-12/report.pdf`, `data/scorecards/raw/fli/summer-2025/page.html`, `comparison.html` (SaferAI), `index.html` (AI Lab Watch, Seoul) — these are the only existing record of "what we transcribed FROM". They live in git, are not content-addressable for source-check, are not user-visible on `/scorecards`. PDF support follows from QUA-942.

---

## 4. Three approaches considered

### Approach A: Do nothing (status quo after QUA-864)

- LLM-against-live continues. Stale waves stay `unchecked`.
- Re-checks pay LLM cost forever.
- Link rot eventually starves the verifier.
- **Pros**: zero work.
- **Cons**: gaps 1–6 stand.

### Approach B: Archive only (no deterministic verify)

- Add `upstream_resource_id` FK on `scorecard_snapshots`.
- Ingester drives `resource-ingest` for each wave's URL, captures stable id.
- Orchestrator's source-fetch path swaps `citation_content` for `resource_content_versions` lookup-by-(url, fetched_at).
- Verdicts are still LLM-generated, but against a frozen snapshot.
- **Pros**: closes Gap 1 and Gap 2. Wave immutability honored. Modest migration.
- **Cons**: still pays LLM cost. Doesn't exploit the fact that we ALREADY know the cell.

### Approach C: Archive + deterministic evidence (recommended)

- Approach B, plus:
- At grade ingest time, write a `source_check_evidence` row **deterministically**:
  ```
  record_type='scorecard_grade'
  record_id=<grade.id>
  field_name='score_raw'  (the canonical scored field)
  resource_id=<archived snapshot's resource sid_>
  source_url=<wave.sourceUrl + optional anchor>
  expected_value=<grade.scoreRaw>
  extracted_value=<grade.scoreRaw>     // by construction equal — we read it from there
  extracted_quote=<surrounding row/sentence>
  verdict='confirmed'
  confidence=1.0
  is_primary_source=true
  checker_model='scorecard-ingest@<adapter-version>'
  ```
- LLM-based check (QUA-864 path) becomes a **drift detector**, not the primary verifier:
  - Run quarterly against `latest=true` snapshots.
  - Fetch live URL, compute content_hash, compare to archive's content_hash.
  - Identical → no-op. Diverged → emit warning, optionally enqueue an LLM re-verification of the changed cells. Don't auto-flip verdicts (the wave is, by construction, what it was on `publishedAt`).
- **Pros**: closes all of Gaps 1–6. Free verification at scale. Wave immutability becomes structural, not policy. Reuses existing schema.
- **Cons**: most work. Requires a `checker_model` taxonomy convention (`scorecard-ingest@vN` is not LLM — UI/dashboard treatment may need a tweak so deterministic evidence isn't shown as "checked by haiku-4-5").

### Why C beats B on cost-benefit

The marginal cost of writing the deterministic evidence row at ingest is one extra `INSERT` per grade × 5076 grades = ~negligible. The verdicts table fills out instantly. Compare: today's plan re-verifies via LLM, paying per call, getting the same answer.

If we ever discover an ingest bug (parser regression), deterministic evidence is the audit trail that catches it: re-running the parser against the archived snapshot and diff'ing against `extracted_value` is the regression test.

---

## 5. Recommended phased plan

Phased so each phase is independently shippable, has clear acceptance, and a partial rollout doesn't degrade what just shipped.

### Phase 1: Archive upstream — `scorecard_snapshots.upstream_resource_id`

**Goal**: every scorecard wave points at an archived `resources` row whose `resource_content_versions` rows preserve the exact CSV/HTML/(PDF later) we transcribed from.

**Schema**:
```sql
ALTER TABLE scorecard_snapshots
  ADD COLUMN upstream_resource_id text REFERENCES resources(stable_id) ON DELETE SET NULL;
CREATE INDEX idx_scorecard_snapshots_upstream ON scorecard_snapshots(upstream_resource_id);
```
Nullable — not every wave has an archivable artifact (e.g. if upstream was a paywalled PDF we can't redistribute). Rollout: in-place on a small table (~11 rows), no NOT VALID needed.

**Ingester wiring** (per source family):

- **FMTI**: `fmti-ingest.ts::syncWaveToServer` — before posting the snapshot, ensure a `resources` row exists for `wave.sourceUrl` (call new `lookupOrCreateResource(url, opts)` helper) and enqueue a `resource-ingest` job synchronously. Capture the resulting stableId. Pass it as `upstreamResourceId` in the snapshot payload.
- **scorecard-import (FLI/SaferAI/AILabWatch/Seoul)**: `crux/lib/scorecard-import/sync.ts` — same shape; the adapter already knows `wave.sourceUrl`. The on-disk sidecar is registered as a SECONDARY resource (`resource_kind='upstream-html'` or `'upstream-pdf'`) once QUA-942 ships; until then we register only the URL.

**Resource registration shape**:
```
resources:
  url: <wave.sourceUrl>
  resource_type: 'scorecard-snapshot-source'   (new value, see Question Q3)
  title: '<scorecardSource> <waveLabel> upstream source'
  description: 'Upstream source for scorecard_snapshots.id=<id>. Fetched at ingest; preserved in resource_content_versions.'
  authority: 'high' (this is the publisher's own page)
resource_content_versions:  (written by resource-ingest worker)
  url, content_hash, content, fetched_at  (one row per fetch; content_hash dedups re-runs)
```

**Deferred dependencies**:
- `resource_tabular_sources` row — only if we want CSV-row addressability (Phase 2). Not strictly needed for archive; raw bytes in `resource_content_versions.content` are the archive.
- PDF support — only matters for FLI 2024-12. Until QUA-942 ships, that wave doesn't get an archive (acceptable; HTML waves cover ~10/11).

**Acceptance**:
- Each `scorecard_snapshots.upstream_resource_id` is non-null for waves with reachable HTTPS URLs (verified 10/11 today; FLI 2024-12 PDF deferred).
- For each such wave, `resource_content_versions` has ≥1 row with content > 0 bytes.
- Re-running the ingester is a no-op (content_hash dedup).
- Existing QUA-864 source-check flow is unaffected (we are not rewriting any read paths).

**Migration / backfill**:
- One-shot crux script `pnpm crux scorecards backfill-archive` walks each wave, registers the resource, enqueues ingest, writes the FK. Idempotent.

**Estimate**: 1 PR, ~300-500 LOC diff, no UI changes.

### Phase 2: Deterministic evidence at grade ingest

**Goal**: every `scorecard_grades` row has a `source_check_evidence` row with `verdict='confirmed'`, written deterministically from the parsed cell value, attached to the upstream archive resource.

**Logic**: in the scorecard sync handler (`apps/wiki-server/src/routes/tablebase/scorecard-grades.ts`), use `writeInlineVerdicts()` (the existing helper at `apps/wiki-server/src/routes/tablebase/write-inline-verdicts.ts`) but extend it to accept a structured evidence shape rather than just a verdict + evidence-string. Or write a sibling helper specifically for deterministic transcribed evidence.

Per-grade evidence shape:
```typescript
{
  recordType: 'scorecard_grade',
  recordId: grade.id,
  fieldName: 'score_raw',
  entityId: grade.entityId,
  resourceId: snapshot.upstreamResourceId,  // from Phase 1
  sourceUrl: grade.sourceUrl ?? snapshot.sourceUrl,
  expectedValue: grade.scoreRaw,
  extractedValue: grade.scoreRaw,
  extractedQuote: <built by adapter; see below>,
  verdict: 'confirmed',
  confidence: 1.0,
  isPrimarySource: true,
  checkerModel: 'scorecard-ingest@v1',
}
```

**`extractedQuote` per source-family**:
- FMTI: the entire CSV row, e.g. `Mistral,1,0,1,...,Total=18`. Adapter has it.
- FLI/SaferAI/AILabWatch/Seoul: the `grades.json` JSON object for the org+dimension. Already in memory at parse time.

This decouples evidence from `extractedQuote` semantics elsewhere (which today is mostly LLM-extracted prose) — so we don't conflate signal types in the dashboard. See Q5 below.

**Coexistence with QUA-864**:
- QUA-864's LLM verifier still runs on `latest=true` waves.
- Recompute verdict (`recomputeVerdict()`) takes the max-confidence/best-verdict across all evidence rows for `(record_type, record_id, field_name)`. Deterministic evidence with `confidence=1.0, is_primary_source=true` will dominate.
- The LLM evidence row, if it disagrees, becomes a CONTRADICTION signal — which is exactly what we'd want surfaced (parser regression OR upstream retraction).

**Acceptance**:
- Every grade in the latest 11 waves has ≥1 `source_check_evidence` row with `verdict='confirmed'`.
- `/scorecards` matrix dots all light up green for archived waves.
- `/internal/sourcing-coverage` shows `scorecard_grade` jumping from current rate to ~100%.
- A unit test demonstrates that re-running the ingester is idempotent (ON CONFLICT update of evidence row, no duplicates).
- A unit test demonstrates that an LLM-written evidence row disagreeing with the deterministic one results in a `partial` or `contradicted` aggregate verdict.

**Migration / backfill**:
- One-shot crux script populates evidence for the existing 5076 grades against their now-archived resources.

**Estimate**: 1 PR, ~400-600 LOC diff. No UI changes (QUA-839 already renders dots).

### Phase 3: LLM as drift detector (optional, lower priority)

**Goal**: catch upstream retractions and silent edits without paying re-check cost on every cell.

**Logic**:
- Scheduled job per `latest=true` wave.
- Re-fetch upstream URL via `resource-ingest` (which content-hash dedups).
- If the new fetch's content_hash matches the archived snapshot's content_hash → no-op.
- If diverged → emit a Linear ticket (or `service_health_incidents`) with a diff summary, mark the wave for human review. Do NOT auto-flip verdicts; wave is, by definition, the value at `publishedAt`.

**Acceptance**:
- A staged test: rewrite the archive's content_hash (simulate divergence), confirm a drift event fires.
- Drift events show up on `/internal/source-check-coverage` or a new `/internal/scorecard-drift` dashboard.

**Estimate**: 1 PR, ~200-300 LOC. Could be deferred until link rot bites in prod.

---

## 6. Schema changes summary

```sql
-- Phase 1 (one migration)
ALTER TABLE scorecard_snapshots
  ADD COLUMN upstream_resource_id text REFERENCES resources(stable_id) ON DELETE SET NULL;
CREATE INDEX idx_scorecard_snapshots_upstream ON scorecard_snapshots(upstream_resource_id);
-- Phase 2 needs no schema change (source_check_evidence already supports everything).
-- Phase 3 may want a `scorecard_drift_events` table — TBD.

-- Optional Phase 1.5 (only if we want addressable rows):
-- INSERT a row into resource_tabular_sources (data_format=csv) for each FMTI wave's CSV.
-- Skip for HTML waves until we decide we want HTML-table-row addressability.
```

PDF resources require QUA-942 (separately ticketed). Phase 1 ships before that and just leaves FLI 2024-12's `upstream_resource_id` NULL until QUA-942 lands.

---

## 7. Test plan

| Layer | What to test | How |
|---|---|---|
| Schema | FK on `upstream_resource_id` enforced; ON DELETE SET NULL works | New `scorecard-archive.test.ts` in wiki-server |
| Ingester (FMTI) | Re-run is idempotent (content_hash dedup); records correct stableId on `scorecard_snapshots` | Unit test against mocked fetch |
| Ingester (scorecard-import) | Same — for at least FLI summer-2025 (HTML wave) | Unit test |
| Deterministic evidence write | One row per grade, idempotent on re-run, correct `extracted_value` and `resource_id` | Test in `apps/wiki-server/src/routes/tablebase/__tests__/scorecard-grades.test.ts` |
| Verdict aggregation | Deterministic + LLM evidence agreeing → `confirmed`. Disagreeing → `contradicted`. | Test `recomputeVerdict()` with mixed evidence |
| Migration | Backfill script idempotent over already-archived waves | Run twice on staging, diff PG state |
| Drift (Phase 3) | Simulated upstream change emits exactly one drift event | Test fixture with controlled content_hash |

Render audit: add a test to `apps/web/e2e/render-audit.spec.ts` that asserts `/scorecards/fmti` shows green dots on at least one wave's grades after Phase 2 ships.

---

## 8. Open questions

| Q | Question | Lean |
|---|---|---|
| Q1 | One `resource` per wave, or one per `(wave, sidecar)`? FLI has both `page.html` AND `report.pdf` for some waves. | One per wave initially. PDF as a SECONDARY resource attached via `entity_resources` if QUA-942 grows that. |
| Q2 | Do we backfill `extractedQuote` for the 5076 existing grades, or only forward? | Backfill for archived waves; cheap (in-process) and gives /sourcing UI rich evidence. |
| Q3 | New `resource_type` value `scorecard-snapshot-source`, or reuse `report` / `dataset`? | New value. Distinct semantics matter for /resources directory filtering. |
| Q4 | Should `scorecard_grades.source_url` be replaced with FK to a `resource_content_version_id`? | No, leave as-is. Per-cell deep-link URL is editorial; resource id lives on the parent snapshot. |
| Q5 | UI treatment of `checker_model='scorecard-ingest@v1'` — same dot color as LLM-checked, or distinct? | Same color (green confirmed). Add a "Checker: scorecard-ingest" line to evidence detail. The DOT shouldn't expose checker provenance; the panel can. |
| Q6 | Drift detection job — what cadence and budget? | Quarterly per active source. ~20 LLM calls/quarter when drift detected. Skip when `sourceActive=false`. |
| Q7 | Does Phase 2 deterministic evidence break the existing relevance-weighting (QUA-791)? | Audit needed. Setting `relevance_score=1.0` should be safe; `recomputeVerdict()` aggregation may need a guard for "is_primary_source && deterministic" to avoid being diluted by low-relevance LLM evidence. |
| Q8 | What about scorecards where the publisher revises grades retroactively (e.g., FMTI corrigendum)? | Treat as a NEW wave. Existing wave row stays immutable. Surfacing the correction is a UI/editorial concern, not a schema concern. |
| Q9 | Storage — `resource_content_versions.content` for ~11 waves × ~3MB CSV/HTML = ~33MB. Re-fetches deduped. Acceptable. | Acceptable. |
| Q10 | What if `resource-ingest` job fails for a wave (paywalled, geofenced, redirect loop)? | Phase 1 leaves `upstream_resource_id=NULL`; Phase 2 falls back to no deterministic evidence for that wave; QUA-864 LLM path still runs for `latest=true`. Document on a `/internal/scorecards-archival-status` dashboard. |

---

## 9. What this is NOT

- **Not** a replacement for QUA-864. The LLM verifier stays useful for drift detection and for source URLs we don't archive.
- **Not** scorecard FactBase mirror (QUA-865) — separate ticket; deterministic evidence is independent of whether grades show up as FBF.
- **Not** PDF support (QUA-942) — separate ticket; Phase 1 ships HTML/CSV waves first.
- **Not** changing `scorecard_grades.score_*` columns or `id` shape.
- **Not** a UI redesign — QUA-839 already wired the dots.
- **Not** a cron / scheduled re-fetch for stale waves; archival is one-shot at ingest.

---

## 10. Cost / risk summary

| Cost | One-time | Recurring |
|---|---|---|
| Engineering | 2-3 PRs (Phase 1 + 2; Phase 3 deferred) | ~Linear-ticket attrition + drift triage |
| Storage | ~30MB (current waves) | Negligible per new wave |
| Compute | One-time backfill (5076 evidence rows) | ~0 — deterministic evidence has no LLM cost |
| LLM spend | $0 net change after Phase 2 (replaces ongoing LLM re-checks for stale waves) | Phase 3: small drift-detection budget |

| Risk | Likelihood | Mitigation |
|---|---|---|
| Resource-ingest flakiness on first archival | medium | Idempotent + retry-friendly; backfill script tolerant to per-URL failures |
| Verdict aggregation regression when deterministic + LLM evidence coexist | medium | Test coverage in `recomputeVerdict()`; manual audit on first 100 grades |
| New `resource_type='scorecard-snapshot-source'` not honored by /resources directory filters | low | Filter list lives in 2-3 files; sweep mechanically |
| Storage growth from periodic re-fetches | low | Content-hash dedup gives O(unique-content) not O(N-fetches) |
| Misalignment with QUA-865 FactBase mirror | low | Deterministic evidence attaches to scorecard_grades; FBF is a join on top |

---

## 11. Tickets to file when this design is approved

1. **Parent**: "Scorecard upstream archival + deterministic source-check (umbrella)" — pointer to this doc, parent QUA-687.
2. **Phase 1**: "scorecard_snapshots.upstream_resource_id + ingester archival wiring".
3. **Phase 2**: "scorecard_grades deterministic source_check_evidence at sync time".
4. **Phase 3** (deferred): "Scorecard upstream drift detection".
5. **Backfill**: "One-shot backfill of evidence rows for existing 5076 grades" (could fold into Phase 2).

Each child ticket should reference this doc and acceptance section.

---

## Appendix A: Code paths touched

### Schema
- `apps/wiki-server/src/schema.ts:4520` — add `upstreamResourceId` to `scorecardSnapshots`.

### Sync handler
- `apps/wiki-server/src/routes/tablebase/scorecard-snapshots.ts:33` — add to Zod schema + toRow.
- `apps/wiki-server/src/routes/tablebase/scorecard-grades.ts:33` — Phase 2 inline-verdict path.
- `apps/wiki-server/src/routes/tablebase/write-inline-verdicts.ts` — extend to accept `expectedValue`/`extractedValue` for deterministic evidence (or write a sibling helper).

### Sourcing aggregation
- `apps/wiki-server/src/routes/sourcing/recompute-verdict.ts` — sanity-check that deterministic primary-source evidence dominates aggregation.

### Crux ingesters
- `crux/lib/scorecards/fmti-ingest.ts::syncWaveToServer` — add `archiveWaveUpstream()` step; capture id; thread through.
- `crux/lib/scorecard-import/sync.ts` — same shape, called from `index.ts` adapter loop.
- New: `crux/lib/scorecards/archive-upstream.ts` — shared `archiveWaveUpstream(url, snapshotId): Promise<resourceId | null>`.

### Crux client
- `crux/lib/wiki-server/scorecard-snapshots.ts` — add `upstreamResourceId` to typed payload.
- New: `crux/lib/wiki-server/resources.ts::ensureResourceForUrl()` — idempotent register-or-lookup.

### Backfill scripts
- New: `crux/scripts/backfill-scorecard-upstream-archive.ts`
- New: `crux/scripts/backfill-scorecard-deterministic-evidence.ts`

### Tests
- `apps/wiki-server/src/routes/tablebase/__tests__/scorecard-grades-archive.test.ts`
- `crux/lib/scorecards/__tests__/archive-upstream.test.ts`
- `apps/web/e2e/render-audit.spec.ts` — augment scorecard cell-dot assertion.

---

## Appendix B: Why not just write a YAML registry

A naive alternative: commit each wave's source URL + content hash to `data/scorecards/registry.yaml`. Bypass PG entirely.

Rejected:
- Doesn't integrate with `source_check_evidence.resource_id`.
- Doesn't give the orchestrator a frozen-content read path.
- Requires a parallel "static archive" surface; loses dedup and indexing.
- The Resources system was designed for exactly this; bypassing it is the bug.

---

## Appendix C: Provenance chain after Phase 2

```
[upstream URL: crfm.stanford.edu/fmti/Dec2025/Dec2025_scores.csv]
         |
         | (resource-ingest worker, content-hashed)
         v
resources.stable_id = sid_FmTiDec2025
         |
         | (scorecard_snapshots.upstream_resource_id FK)
         v
scorecard_snapshots.id = fmti-dec-2025
         |
         | (scorecard_grades.snapshot_id FK)
         v
scorecard_grades.id = fmti-dec-2025__sid_mistral__indicator-23
   scoreRaw = "1"
         |
         | (deterministic evidence write at sync time)
         v
source_check_evidence:
   record_type='scorecard_grade'
   record_id='fmti-dec-2025__sid_mistral__indicator-23'
   resource_id='sid_FmTiDec2025'           <-- archive
   extracted_value='1'                     <-- by construction == scoreRaw
   verdict='confirmed'
   checker_model='scorecard-ingest@v1'
         |
         | (recomputeVerdict aggregation)
         v
source_check_verdicts:
   record_type='scorecard_grade'
   record_id='fmti-dec-2025__sid_mistral__indicator-23'
   verdict='confirmed'
   confidence=1.0
         |
         | (LEFT JOIN on /api/scorecard-grades/all)
         v
UI dot lights green on /scorecards/fmti and /organizations/mistral?tab=scorecards
```

---

## 12. Critique + Revisions

This section captures findings from five red-team passes against the body above. **Several claims in §3–§5 are wrong or weakly supported; this section corrects them.** When the body and this section disagree, this section is the current view.

### 12.1 Pass 1 — Technical correctness (verified against code)

**Finding 1.1 (high) — `is_primary_source` does not affect aggregation.**

§4 Approach C and §5 Phase 2 both claim "deterministic evidence with `confidence=1.0, is_primary_source=true` will dominate". This is **wrong**. `apps/wiki-server/src/routes/sourcing/sourcing-aggregation-types.ts:44` defines `EvidenceRow` as only `{ verdict, relevanceScore, confidence }`. `is_primary_source` and `checker_model` are neither read nor weighted. The actual aggregation rule (`sourcing-aggregation.ts`):

1. Drop `not_applicable` rows.
2. If all remaining rows have `effectiveWeight < 0.3` (`relevance_score ?? 1.0`), return `unchecked`.
3. Bucket by verdict, weight = sum of `effectiveWeight` per bucket.
4. Highest-weighted bucket wins; tie broken by priority ladder: **`contradicted > outdated > partial > unverifiable > confirmed > unchecked`** (most-actionable first).

**Implication**: If we write deterministic `confirmed` (relevance=1.0) AND the LLM later writes `contradicted` (relevance=1.0, single source), the aggregator returns `contradicted` — because the priority ladder breaks the weight tie toward contradiction. This is probably what we want when there's genuine drift, but it means deterministic evidence does NOT structurally "win" — it's a single voice among others.

**Correction**: do not write LLM evidence when deterministic evidence exists. Either (a) skip LLM verification when a deterministic confirmed row already covers the claim, or (b) tag deterministic rows with a special `relevance_score` (e.g., `2.0` clamped to `1.0` after read — no, the resolver clamps; doesn't help) — really the cleaner answer is (a). See §12.6 below.

**Finding 1.2 (high) — `crux/lib/sourcing/deterministic-matcher.ts` already exists.**

§4 and §5 propose "write a new helper to write deterministic evidence at sync time". The system already has `matchRecordAgainstSnapshot()` (`crux/lib/sourcing/deterministic-matcher.ts:117`) and `tryDeterministicMatch()` (`crux/lib/sourcing/item-verifier.ts:204`) wired into the orchestrator's per-item path. Grants flow through this today. **The right design reuses this, not invent a parallel path.**

The trade-off:
- **Reuse path** (orchestrator + deterministic matcher): more code, more surface, more wiring (need a `DataSourceManifest` for each scorecard wave, need to teach the matcher about pivot tables — see Finding 1.5). Verdict population happens via the verify run, not at ingest.
- **Sync-time path** (write evidence inside `scorecard-grades.ts` POST /sync): less code, evidence populates immediately on ingest, but bypasses the canonical orchestrator. Slightly inconsistent with grants.

**Correction**: lean toward sync-time writes for **scorecards** because their adapter knows the literal cell value at parse time — there is no "match against snapshot" to do. The orchestrator path is for cases where the record is opaque and the matcher needs to find the row. Scorecards never have that uncertainty. Document this difference explicitly so future record-type integrations don't pattern-match the wrong precedent.

**Finding 1.3 (medium) — Grants archive uses `source_snapshots`, not `resource_content_versions`.**

§2.4 said `resource_content_versions` is the right place. §5 Phase 1 said "use `resource-ingest` worker". But `crux/lib/grant-import/snapshot-capture.ts` calls `createSnapshot()` which writes to `source_snapshots` (the LEGACY tabular path), and the deterministic matcher reads from `getLatestSnapshot()` which queries `source_snapshots`.

`resource_content_versions` is the **forward direction** of consolidation (per migration 0159's docstring), but grants haven't migrated. If scorecards write to `resource_content_versions`, the matcher can't read them.

**Correction**: write to `source_snapshots` for scorecards too. Filing a separate ticket to migrate both grants AND scorecards to `resource_content_versions` is a bigger reform that shouldn't block this work.

**Finding 1.4 (medium) — `resource_type` taxonomy is more nuanced than I described.**

§5 proposed `resource_type='scorecard-snapshot-source'`. The actual `resources` table has FOUR fields:
- `type` — old/coarse field.
- `resourcePurpose` — `homepage | primary_source | commentary | dataset | tool`.
- `resourceSubtype` — `arxiv_preprint | blog_post | executive_order | ...`.
- `contentLifecycle` — `immutable | versioned | evergreen | ephemeral`.

**Correction**: use `resourcePurpose='primary_source'` + `resourceSubtype='scorecard-wave'` + `contentLifecycle='versioned'`. Don't add a new top-level `resource_type` value.

**Finding 1.5 (high) — Pivot-table matching is non-trivial.**

§5 Phase 2 hand-waved "the adapter has the cell". For FMTI specifically, the upstream CSV is a PIVOT TABLE: rows are indicators, columns are orgs (`Indicator,Anthropic,OpenAI,Mistral,...,Total`). The current `matchRecordAgainstSnapshot` assumes one CSV row maps to one record (grants pattern). For scorecards we'd need:
- (a) Synthesize per-grade rows at parse time and store the denormalized `{indicator, org, score}` triples as the snapshot.
- (b) Extend `matchRecordAgainstSnapshot` to support pivot-table lookups.
- (c) Skip deterministic matching entirely; just archive raw + write evidence at sync time (Finding 1.2's correction makes this consistent).

**Correction**: pick (c) for now. Re-verification via the matcher becomes a Phase 3 question if it ever matters; a separate re-check tool can re-parse the snapshot and diff against `scorecard_grades` without going through the orchestrator's per-item path.

### 12.2 Pass 2 — Missing alternatives

The body considered three approaches (do nothing / archive only / archive + deterministic). Several others were dismissed silently:

**Wayback Machine first**. Just lookup-or-trigger an archive.org snapshot per wave URL. Pro: free, mature, no PG storage. Con: doesn't snapshot `raw.githubusercontent.com/...` reliably; no FK target for `source_check_evidence.resource_id`; no programmatic guarantee of point-in-time fidelity.

**Git-as-archive (extend current pattern)**. The 4 hand-curated sources already commit a sidecar (`page.html`, `report.pdf`, `comparison.html`, `index.html`). Extend FMTI to commit its CSVs the same way. Pro: simplest, version-controlled, no schema change. Con: doesn't integrate with `source_check_evidence`, repo bloat over time (~10MB per FMTI wave snapshot × N years), no content-hash dedup, manual.

**FactBase as archive**. QUA-865 proposes mirroring grades into FactBase facts. FactBase already has provenance (source field). Pro: reuses one machinery. Con: FactBase isn't designed as a raw-content archive; scorecard data is more relational than fact-shaped (see QUA-865 body); we'd be conflating archive with semantics.

**Hybrid: file-URI resources**. Register the on-disk sidecar path (`file:///data/scorecards/raw/fli/2024-12/report.pdf`) as a `resources` row. Pro: no fetch dependency at ingest; trivially reproducible. Con: weird FK semantics, doesn't survive cross-machine, doesn't help for FMTI which fetches at runtime.

**Recommendation revision**: a hybrid is genuinely worth considering. **For 4 of 5 sources, the sidecar is already on disk** — registering it as a resource (with `url=https://<original>`, `localFilename=<path>`, `archiveUrl=<wayback URL if found>`, content stored in `source_snapshots.rawContent` from local file) is cheaper than re-fetching. FMTI is the only source that needs network fetch at archival time.

### 12.3 Pass 3 — Cost / value reality check

**Is link rot a real problem here?** Empirically: Stanford CRFM has moved /fmti/ paths once (caught in §1 of body), but historical waves still resolve. FLI keeps wave pages up. SaferAI is continuously-updated (their "old" data isn't archived by them). AI Lab Watch is frozen (good — won't change). Seoul-tracker has stable URLs.

So link rot risk is **medium for SaferAI** (continuous update means historical pillar values aren't frozen anywhere upstream), **low everywhere else**.

**Is LLM cost real?** 5076 grades × ~$0.0005 per Haiku check = **~$2.50 for a full sweep**. Quarterly re-check = ~$10/year. **This is rounding error.** §4 Approach C's "free verification at scale" pitch is overselling.

**What is the real value of Phase 2?**
- *Not* cost savings (Finding 3.2 above).
- *Not* faster (LLM check is asynchronous; deterministic write at ingest is also fine).
- **Yes** parser-regression detection: if our CSV parser breaks tomorrow and silently corrupts scoreNumeric, deterministic evidence written from the OLD parser will mismatch new grade rows during the next ingest, and we have an audit trail.
- **Yes** wave immutability for stale waves: once Oct 2023's archive is in PG, "what did Stanford say in Oct 2023?" has a non-floating answer.

**Is the deterministic verdict semantically different?** No — both the LLM and the deterministic check produce `confirmed`/`contradicted`. UI is identical. End user can't tell.

**Updated cost-benefit**: Phase 1 (archive) is the load-bearing piece. Phase 2 (deterministic at sync) is a nice optimization but not load-bearing. Phase 3 (drift) only matters if we expect upstream changes in continuously-updated sources.

### 12.4 Pass 4 — Edge cases and operational hazards

**Paywall / geofencing**: zero scorecards paywalled today. SaferAI uses Cloudflare; their `https://ratings.safer-ai.org/comparison/` may rate-limit. Resource-ingest worker has Wayback fallback and Firecrawl integration; inheriting these.

**Licensing / redistribution**: most scorecards are CC-BY (FMTI, FLI). SaferAI is CC-BY-SA. Seoul: terms unclear. Storing internally for verification is fine under all licenses; **don't expose the snapshot via public API** for non-redistributable sources. Add a `redistributable: bool` flag on `resources` (or use existing `license` text) and gate the `/api/source-snapshots/:id/raw` endpoint accordingly. (Or just don't expose raw content via API at all — the existing source-check pipeline reads PG directly server-side.)

**Wave revisions**: FMTI v1.2 publishes a corrigendum. Naive: re-ingest, content_hash differs, new `source_snapshots` row. The OLD snapshot is preserved (append-only). Old grade rows still point at the old snapshot id (if we add `upstream_resource_content_version_id`) or the snapshot table generally. Decision needed: should grade rows pin to a specific snapshot version, or to the wave's resource (which has multiple versions)?

  **Lean**: grade rows belong to a `scorecard_snapshots` row; the wave's resource link points at the wave; per-version snapshot history lives in `source_snapshots`. If a corrigendum lands, the rule is "treat it as a NEW wave (`fmti-dec-2025-r2`)" — preserve immutability of every wave we ever shipped grades from.

**Disagreement noise**: if both deterministic + LLM run, and the LLM hallucinates `contradicted`, the priority ladder makes the aggregate `contradicted`. **Mitigation**: skip LLM evidence write when a deterministic confirmed row already exists for `(record_type, record_id, field_name)`. This is a small change to QUA-864's orchestrator filter.

**Resource lookup race**: two concurrent ingester runs hitting the same URL. `resources.idx_res_url` is unique → upsert is idempotent. No real risk.

**SSRF**: source-fetcher already enforces `isPrivateHost`. Inheriting this is free.

**Resource-ingest job ordering**: archive step is a per-wave fetch. ~11 waves × 30s = 5min worst-case. Acceptable; can parallelize trivially since URLs are independent.

**Failure mode if archive fails**: per Finding 12.4, leave `upstream_resource_id=NULL`. Don't block grade sync. QUA-864 LLM path still runs as fallback.

### 12.5 Pass 5 — Scope creep and ticket hygiene

Per `.claude/rules/ticket-sizing.md`:

- **Phase 1 as one PR**: schema + crux client + 2 ingester families + 1 backfill script. Touches 4-5 surfaces. Borderline; 5/5 of the "split it" red flags are not present (no mixed shapes, no batch processing, no >1K rows, no "phase" wording in body, no "and" connector). Can ship as one PR. If reviewer pushback, split into "schema + crux client (no behavior change)" and "ingester wiring per family".
- **Phase 2**: writing evidence at sync time. One handler change + tests. Single shape. Fits one PR.
- **Phase 3**: drift detection. Separate ticket; defer.
- **Backfill**: should be folded into Phase 2, not its own ticket — it's the "run the new code path against existing data" call.

Per `.claude/rules/linear-project-ownership.md`: source-check work goes in **Source-Check & Verification**. All three phases qualify.

Per `.claude/rules/proactive-github-filing.md`: I'm proposing 3 tickets in §11 (revised down from 5). I should **not** file these without explicit ask — the user requested a doc, not implementation. §11 should clarify "to be filed if/when this design is approved, by the user, not by this session."

Per `.claude/rules/error-handling.md`: archival should be **best-effort**. Don't fail the whole grade sync if one wave's URL 404s. Log warning + leave FK null + emit a Linear ticket (auto-filed) so a human can decide.

### 12.6 Revised recommendation

**Sequence**:

1. **Phase 1 (recommended now)**: archive each wave's upstream URL into `resources` + `source_snapshots`. Add `upstream_resource_id text REFERENCES resources(stable_id)` on `scorecard_snapshots`. Use the grants pattern (`createSnapshot()` + `resource_tabular_sources`). Use `resourcePurpose='primary_source'` + `resourceSubtype='scorecard-wave'` + `contentLifecycle='versioned'`. Best-effort failure mode: leave FK null on per-wave failure, log warning, optionally file a Linear ticket. ~1 PR, low risk.

2. **Phase 2 (defer; reconsider after Phase 1)**: once Phase 1 lands and an archive resource exists per wave, optionally write deterministic `source_check_evidence` rows at scorecard-grades sync time. Configure QUA-864 orchestrator to skip LLM check when a confirmed deterministic row already exists for `(record_type, record_id, field_name)`. Marginal value given LLM cost is trivial — only do this if Phase 1 makes it nearly-free. ~0.5 PR.

3. **Phase 3 (defer indefinitely)**: drift detection. Only build if SaferAI (the most-likely-to-drift source) starts producing observable verdict drift after Phase 1.

4. **Out of this doc's scope**: PDF support (QUA-942), FactBase mirror (QUA-865), grants migration to `resource_content_versions`.

**Net recommendation to the user**: file ONE Linear ticket for Phase 1. Defer Phases 2-3 as backlog items pending operational signal.

### 12.7 Additional findings worth filing as separate tickets

- **Aggregation has no concept of primary/authoritative source** — `is_primary_source` column exists but is unread. Either remove the column (DRY) or wire it into aggregation (so manually-curated primary-source evidence can override LLM noise). One-paragraph Linear ticket.
- **`recompute-verdict.ts` doesn't read `relevance_score` from disk for legacy rows** — verify; if true, file as bug.
- **Grants-vs-scorecards-vs-future: which snapshot table?** — `source_snapshots` (legacy) vs `resource_content_versions` (forward) — pick a winner and migrate the loser. Filing a Linear ticket as parent for "consolidate snapshot storage" is overdue.

These are observations, not blocking work. The user/maintainer should decide whether to triage them.

---

## 13. Process critique (this session)

Three things this design process got wrong, worth capturing for the next time someone writes a doc like this:

1. **Did not do the "what already shipped" check first.** Spent ~half the investigation budget designing a system before discovering QUA-864 had merged 6 hours earlier covering most of the LLM-side. Should have run `pnpm crux linear search` against several keyword combinations at the very start.

2. **Did not verify aggregation rules against code.** Wrote a doc claiming `is_primary_source` would dominate, then discovered in red-team that the column is unused. The body is preserved; the corrections are in §12. **Heuristic for next time**: every claim about "X dominates Y" or "field A overrides field B" needs a code citation BEFORE it goes in the body, not after.

3. **Did not look at existing precedent (`deterministic-matcher.ts`) before proposing a new helper.** The grants pattern was right there. Three minutes of `grep -r deterministic crux/lib/sourcing` would have caught this. Pattern to internalize: "when adding a new record type to a system that has N record types, read all N implementations first."

The doc is more valuable for these mistakes being explicit than for being rewritten as if they didn't happen. If the project picks this work up, the §12 corrections are load-bearing — the §1-§11 body is for context.

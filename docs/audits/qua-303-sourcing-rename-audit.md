# QUA-303 Sourcing Rename — Phase 0 Audit

**Scope:** Final phase of the `source_check_*` → `sourcing_*` rename (parent: QUA-102). Inventory of PG objects, Drizzle bindings, SQL call sites, and code consumers so Phase 1 (the actual DDL) has complete context.

**Linear:** [QUA-303](https://linear.app/quantifieduncertainty/issue/QUA-303). Precondition tracker: [QUA-351](https://linear.app/quantifieduncertainty/issue/QUA-351) scheduled 2026-04-19.

**Phase 0 deliverables (this PR):** audit doc + draft migration SQL in `apps/wiki-server/scripts/` (not wired to Drizzle journal). No prod DDL. No schema.ts edits. No call-site edits.

---

## Preconditions re-check (2026-04-13)

The QUA-303 ticket filed six preconditions. Status after this audit:

| # | Precondition | Status | Notes |
|---|---|---|---|
| 1 | 7 consecutive green wiki-server deploys | ❌ **5 of 7** | Clean since 0173 fix 2026-04-12 06:01 UTC (#4180, #4215, #4225, #4258, #4295). ~43h at audit time. |
| 2 | Ratchet baseline flat at 7 for 7 days | ✅ **Flat at 1 (not 7)** | `crux/validate/.sourcing-baseline.json` frozen at 1 since QUA-296. The lone remaining ref is `sourceCheckedAt` on `_archived_claim_sources` — archived table, all-NULL column, not used in live code. |
| 3 | Alias `/api/source-checks/*` unused by externals | ✅ **Retired** | QUA-358 (commit `76978aa52`) dropped the alias. This precondition no longer applies. |
| 4 | FK audit complete | ✅ **Complete (see below)** | Scope is much smaller than the ticket assumed. |
| 5 | No active incident on adjacent systems | ⚠️ **TWO flags** | (a) Main CI cascade of 9 failures 2026-04-14 00:31–00:46 UTC from `validate-sourcing-lint-guard` test; resolved by PR #4312 at 00:52 UTC. (b) Groundskeeper `job-worker-health` circuit breaker **actively tripped** since 2026-04-13 22:20 UTC, failing half-hourly without a captured `error_message`. Deploy pipeline unaffected by either. |
| 6 | QUA-295 done | ✅ | PR #4250 shipped. |

### Revised safe-start date

**Original target:** 2026-04-18 (7 days post-0173).

**Revised Phase 1 target:** **2026-04-16 01:00 UTC minimum, contingent on (a) 48h clean main CI after the ratchet-guard fix at 2026-04-14 00:52 UTC, and (b) `job-worker-health` circuit breaker resolved or root-caused.**

Rationale for shortening by 2 days: the FK audit shows 0 inbound FKs and 0 views on both tables, alias precondition already met by QUA-358, ratchet already at 1, and the primary column rename is on an archived table. The original 7-day window was calendar-conservative with an unknown-unknowns margin; with the FK blast radius documented, that margin is much smaller.

---

## PG object inventory (prod, 2026-04-13)

### `source_check_evidence` (→ `sourcing_evidence`)

- **Rows:** 13,556
- **Sequence:** `verification_evidence_id_seq` (historical name from migration 0131 rename — unchanged intentionally)
- **Primary key:** `verification_evidence_pkey` on `id`
- **Indexes:**
  - `idx_sce_record` btree (record_type, record_id)
  - `idx_sce_entity` btree (entity_id)
  - `idx_sce_verdict` btree (verdict)
  - `idx_sce_checked` btree (checked_at)
  - `idx_sce_dedup` UNIQUE btree (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''))
- **Check constraints:** `chk_source_check_evidence_verdict` (verdict IN 5 values)
- **Outbound FKs:** `verification_evidence_resource_id_fkey` → `resources(id) ON DELETE SET NULL`
- **Inbound FKs:** **none**
- **Views depending on it:** **none**

### `source_check_verdicts` (→ `sourcing_verdicts`)

- **Rows:** 12,740
- **No primary key constraint** (uses unique index for identity)
- **Indexes:**
  - `idx_scv_pk` UNIQUE btree (record_type, record_id, COALESCE(field_name, ''))
  - `idx_scv_verdict` btree (verdict)
  - `idx_scv_recheck` btree (needs_recheck)
  - `idx_scv_entity` btree (entity_id)
  - `idx_scv_type` btree (record_type)
- **Check constraints:** `chk_source_check_verdicts_verdict` (verdict IN 6 values)
- **Outbound FKs:** **none**
- **Inbound FKs:** **none**
- **Views depending on it:** **none**

### `claim_sources.source_checked_at` (→ cosmetic)

- **Live table:** does not exist.
- **Archived table:** `_archived_claim_sources` (renamed in migration 0065). 585 rows, `source_checked_at` column is all NULL.
- **Drizzle binding:** `sourceCheckedAt` at `apps/wiki-server/src/schema.ts:580`.
- **Other code references:** none. `grep -rn "sourceCheckedAt"` returns only `schema.ts`.
- **Conclusion:** Renaming this column is cosmetic cleanup of an archived table. It is the lone ref keeping the ratchet at 1. Renaming it drops the ratchet to 0.

---

## Write-activity profile (last 48h, prod)

| Hour (UTC) | `source_check_evidence` writes | `source_check_verdicts` writes |
|---|---|---|
| 2026-04-13 02:00 | 8 | 4 |
| 2026-04-13 10:00 | 473 | 568 |
| 2026-04-13 11:00 | 34 | 90 |
| 2026-04-13 19:00 | 32 | 32 |
| All other hours | 0 | 0 |

Bursty and low-volume — peak 568 writes/hour, most hours idle. An `ALTER TABLE RENAME` is metadata-only (milliseconds, no row scan, no data copy), so the "heavy-write tables" concern in the ticket overstates real-time risk. Contrast with 0173's `ADD CONSTRAINT` on a 905 MB / 3.3M-row table which did a full scan under ACCESS EXCLUSIVE.

---

## Code call-site inventory

### Drizzle bindings in schema.ts

| Line | JS export | PG table |
|---|---|---|
| 1670 | `recordSources` | `source_check_evidence` |
| 1716 | `sourceVerdicts` | `source_check_verdicts` |
| 580 | `sourceCheckedAt` (col prop) | `source_checked_at` on `_archived_claim_sources` |

### Consumers of `sourceVerdicts` / `recordSources` (9 files)

Found via `grep -rn "sourceVerdicts\|recordSources" --include="*.ts"`:

```
apps/wiki-server/src/routes/shared/sourcing-join.ts
apps/wiki-server/src/routes/sourcing/sourcing.ts
apps/wiki-server/src/routes/tablebase/entity-profile.ts
apps/wiki-server/src/routes/tablebase/grants.ts
apps/wiki-server/src/routes/tablebase/personnel.ts
apps/wiki-server/src/routes/tablebase/scanner-results.ts
apps/wiki-server/src/routes/tablebase/things.ts
apps/wiki-server/src/routes/wikibase/citations.ts
apps/wiki-server/src/schema.ts
```

### Raw SQL references to `source_check_evidence` / `source_check_verdicts` (live, non-migration)

Found via `grep -rn "source_check_evidence\|source_check_verdicts" --include="*.ts" --include="*.sql"` minus historical Drizzle migrations:

| File | Refs |
|---|---|
| `apps/wiki-server/src/schema.ts` | 7 (table names, doc comments) |
| `apps/wiki-server/src/routes/sourcing/sourcing.ts` | 15 |
| `apps/wiki-server/src/routes/shared/sourcing-join.ts` | 4 |
| `apps/wiki-server/src/routes/tablebase/write-inline-verdicts.ts` | 4 |
| `apps/wiki-server/src/routes/tablebase/things.ts` | 3 |
| `apps/wiki-server/src/routes/operational/data-quality.ts` | 2 |
| `apps/wiki-server/src/routes/wikibase/citations.ts` | 1 |
| `apps/wiki-server/src/routes/wikibase/pages.ts` | 1 |
| `apps/wiki-server/src/__tests__/sourcing-evidence-by-records.test.ts` | 11 |
| `apps/wiki-server/src/__tests__/citations.test.ts` | 4 |
| `apps/wiki-server/src/__tests__/sourcing-coverage.test.ts` | 2 |
| `apps/wiki-server/src/__tests__/sourcing-cleanup-orphans.test.ts` | 2 |
| `apps/wiki-server/src/__tests__/scanner-results.test.ts` | 1 |
| `apps/web/src/data/entity-nav.ts` | 1 |
| `apps/web/src/data/tablebase.ts` | — (grep hit, doc/string) |
| `apps/web/src/lib/citation-data.ts` | 2 |
| `crux/lib/job-handlers/claim-sourcing.ts` | 1 |
| `crux/scripts/backfill-fact-entity-ids.ts` | 1 |
| `crux/commands/migrate-citations.ts` | 1 |
| `crux/validate/validate-sourcing-lint-guard.ts` | 2 (part of the ratchet itself) |
| `crux/lib/sourcing-dedup.test.ts` | 1 |
| `crux/lib/sourcing/bare-id-resolution.test.ts` | 1 |

Historical Drizzle migrations (`apps/wiki-server/drizzle/*.sql`) are frozen-in-time and must not be rewritten.

---

## Recommended phased rollout

Metadata-only renames (no row scan) do not need the full "manual script + NOT VALID" pattern that 0173 needed. The precedent is migration 0131 (verification → source_check) which renamed both tables as a normal Drizzle migration with no incident. The previous rename succeeded in prod with the same PG, same approximate row counts.

However, rolling deploys create a window where old pods are still serving with the old code (reading the old table name). A clean `ALTER TABLE RENAME` mid-deploy would make old-pod queries fail with `relation "source_check_evidence" does not exist`.

Two valid patterns:

### Pattern A — Big-bang (one PR)

1. Drizzle migration renames both tables (metadata-only, instant).
2. Same PR updates `schema.ts` bindings + all call sites.
3. Deploy. Rolling window makes old pods briefly error.

**Tradeoff:** Simple, one PR. Accepts ~60s of old-pod 500s during K8s rolling deploy.

### Pattern B — Views for grace window (3 PRs)

1. **Phase 1 PR:** Drizzle migration renames tables and creates views with the old names.
   - `ALTER TABLE source_check_evidence RENAME TO sourcing_evidence;`
   - `CREATE VIEW source_check_evidence AS SELECT * FROM sourcing_evidence;`
   - Old code keeps working via the view (PostgreSQL auto-updatable views support INSERT/UPDATE/DELETE on simple `SELECT * FROM table` views, including `ON CONFLICT`).
2. **Phase 2 PR:** Update `schema.ts` bindings + all call sites to new names. Deploy atomically.
3. **Phase 3 PR (≥7 days later):** Drop the views.

**Tradeoff:** Three PRs, zero old-pod errors. Recommended given the 0173 history.

This PR drafts **Pattern B** scripts. See `apps/wiki-server/scripts/phase1-sourcing-rename.sql` and `apps/wiki-server/scripts/phase3-drop-sourcing-views.sql`.

---

## Reproducing this audit

```bash
# FK / index / view audit
psql "$PRODUCTION_DB_URL" <<'SQL'
\d+ source_check_evidence
\d+ source_check_verdicts
SELECT conname, conrelid::regclass, confrelid::regclass
FROM pg_constraint
WHERE contype='f' AND (confrelid::regclass::text IN ('source_check_evidence','source_check_verdicts')
                      OR conrelid::regclass::text IN ('source_check_evidence','source_check_verdicts'));
SELECT dependent_view.relname, source_table.relname
FROM pg_depend JOIN pg_rewrite ON pg_depend.objid=pg_rewrite.oid
JOIN pg_class dependent_view ON pg_rewrite.ev_class=dependent_view.oid
JOIN pg_class source_table ON pg_depend.refobjid=source_table.oid
WHERE source_table.relname IN ('source_check_evidence','source_check_verdicts')
  AND dependent_view.relkind='v';
SQL

# Call-site inventory
grep -rn "sourceVerdicts\|recordSources" --include="*.ts" | grep -v node_modules
grep -rn "source_check_evidence\|source_check_verdicts" --include="*.ts" --include="*.sql" | grep -v node_modules
grep -rn "sourceCheckedAt" --include="*.ts"
```

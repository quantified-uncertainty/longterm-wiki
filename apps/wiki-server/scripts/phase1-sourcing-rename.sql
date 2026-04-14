-- QUA-303 Phase 1: rename source_check_* tables to sourcing_*, create back-compat views.
-- DRAFT — not yet wired into a Drizzle migration. See docs/audits/qua-303-sourcing-rename-audit.md.
--
-- WHY A MANUAL SCRIPT (not a Drizzle migration):
--   - This is metadata-only (`ALTER TABLE ... RENAME` does not scan rows, unlike 0173's
--     `ADD CONSTRAINT CHECK` which scanned 3.3M rows under ACCESS EXCLUSIVE).
--   - But we still want the views intact for the rolling-deploy window, which means
--     Phase 2 (code update) needs to deploy with views in place. A Drizzle migration
--     at startup would atomically rename tables in lockstep with the new code — but
--     any old pod still running during the rolling window would see its queries fail.
--   - Running Phase 1 as a separate manual step lets us verify views work in prod BEFORE
--     any code change deploys.
--
-- PRECONDITIONS (re-check at run time — see docs/audits/qua-303-sourcing-rename-audit.md):
--   - wiki-server deploys clean for ≥48h after ratchet-guard fix 2026-04-14 00:52 UTC
--   - job-worker-health groundskeeper circuit breaker not active
--   - `source_check_evidence` and `source_check_verdicts` row counts match pre-audit ±delta
--   - No FK changes since audit (`\d+` inspection)
--
-- ROLLBACK: see phase1-sourcing-rename-rollback.sql

BEGIN;

-- Use a short lock_timeout to fail fast if anything holds a conflicting lock.
-- Unlike 0173 (which needed the scan to complete), RENAME is instant once the lock
-- is acquired, so 5s is generous.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Rename tables.
ALTER TABLE source_check_evidence RENAME TO sourcing_evidence;
ALTER TABLE source_check_verdicts RENAME TO sourcing_verdicts;

-- 2. Rename check constraints to match new table names (purely cosmetic but keeps
--    constraint names grep-aligned with table names).
ALTER TABLE sourcing_evidence RENAME CONSTRAINT chk_source_check_evidence_verdict
  TO chk_sourcing_evidence_verdict;
ALTER TABLE sourcing_verdicts RENAME CONSTRAINT chk_source_check_verdicts_verdict
  TO chk_sourcing_verdicts_verdict;

-- 3. Rename FK constraint (only one — evidence → resources).
ALTER TABLE sourcing_evidence RENAME CONSTRAINT verification_evidence_resource_id_fkey
  TO sourcing_evidence_resource_id_fkey;

-- 4. Rename primary key constraint.
ALTER TABLE sourcing_evidence RENAME CONSTRAINT verification_evidence_pkey
  TO sourcing_evidence_pkey;

-- 5. Rename sequence (cosmetic — nextval() still works regardless).
ALTER SEQUENCE verification_evidence_id_seq RENAME TO sourcing_evidence_id_seq;

-- 6. Rename indexes to sc* → sourcing_ev / sourcing_vr prefix.
ALTER INDEX idx_sce_record   RENAME TO idx_sourcing_ev_record;
ALTER INDEX idx_sce_entity   RENAME TO idx_sourcing_ev_entity;
ALTER INDEX idx_sce_verdict  RENAME TO idx_sourcing_ev_verdict;
ALTER INDEX idx_sce_checked  RENAME TO idx_sourcing_ev_checked;
ALTER INDEX idx_sce_dedup    RENAME TO idx_sourcing_ev_dedup;
ALTER INDEX idx_scv_pk       RENAME TO idx_sourcing_vr_pk;
ALTER INDEX idx_scv_verdict  RENAME TO idx_sourcing_vr_verdict;
ALTER INDEX idx_scv_recheck  RENAME TO idx_sourcing_vr_recheck;
ALTER INDEX idx_scv_entity   RENAME TO idx_sourcing_vr_entity;
ALTER INDEX idx_scv_type     RENAME TO idx_sourcing_vr_type;

-- 7. Create back-compat views under the old names.
--    Auto-updatable views (simple `SELECT * FROM table`) support INSERT / UPDATE /
--    DELETE / ON CONFLICT in PostgreSQL 9.3+. Old pods can continue writing through
--    these views until Phase 2 deploy completes.
CREATE VIEW source_check_evidence AS SELECT * FROM sourcing_evidence;
CREATE VIEW source_check_verdicts AS SELECT * FROM sourcing_verdicts;

-- 8. Verify view updatability (check-only, no mutation).
DO $$
DECLARE
  ev_updatable text;
  vr_updatable text;
BEGIN
  SELECT is_updatable INTO ev_updatable
    FROM information_schema.views WHERE table_name = 'source_check_evidence';
  SELECT is_updatable INTO vr_updatable
    FROM information_schema.views WHERE table_name = 'source_check_verdicts';
  IF ev_updatable <> 'YES' OR vr_updatable <> 'YES' THEN
    RAISE EXCEPTION 'Back-compat views are not auto-updatable: evidence=%, verdicts=%',
      ev_updatable, vr_updatable;
  END IF;
END $$;

COMMIT;

-- Post-run smoke check (run separately, not in the transaction):
--   SELECT count(*) FROM sourcing_evidence;        -- expect ~13,556+
--   SELECT count(*) FROM source_check_evidence;    -- expect same count via view
--   INSERT INTO source_check_verdicts (record_type, record_id, verdict)
--     VALUES ('__phase1_smoke__', 'test', 'unchecked');
--   DELETE FROM source_check_verdicts WHERE record_id = 'test' AND record_type = '__phase1_smoke__';

-- QUA-303 Phase 1 ROLLBACK — reverse the sourcing_* rename.
-- Use only if Phase 1 caused an issue AND Phase 2 (code update) has NOT deployed yet.
-- Once Phase 2 is deployed, rollback requires reverting that PR instead.
--
-- This script is safe to run while the back-compat views exist: it drops the views,
-- renames tables back, and restores all original names.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Drop the back-compat views (they point to the new names).
DROP VIEW IF EXISTS source_check_evidence;
DROP VIEW IF EXISTS source_check_verdicts;

-- 2. Rename tables back to the old names.
ALTER TABLE sourcing_evidence RENAME TO source_check_evidence;
ALTER TABLE sourcing_verdicts RENAME TO source_check_verdicts;

-- 3. Restore check constraint names.
ALTER TABLE source_check_evidence RENAME CONSTRAINT chk_sourcing_evidence_verdict
  TO chk_source_check_evidence_verdict;
ALTER TABLE source_check_verdicts RENAME CONSTRAINT chk_sourcing_verdicts_verdict
  TO chk_source_check_verdicts_verdict;

-- 4. Restore FK + PK constraint names.
ALTER TABLE source_check_evidence RENAME CONSTRAINT sourcing_evidence_resource_id_fkey
  TO verification_evidence_resource_id_fkey;
ALTER TABLE source_check_evidence RENAME CONSTRAINT sourcing_evidence_pkey
  TO verification_evidence_pkey;

-- 5. Restore sequence name.
ALTER SEQUENCE sourcing_evidence_id_seq RENAME TO verification_evidence_id_seq;

-- 6. Restore index names.
ALTER INDEX idx_sourcing_ev_record   RENAME TO idx_sce_record;
ALTER INDEX idx_sourcing_ev_entity   RENAME TO idx_sce_entity;
ALTER INDEX idx_sourcing_ev_verdict  RENAME TO idx_sce_verdict;
ALTER INDEX idx_sourcing_ev_checked  RENAME TO idx_sce_checked;
ALTER INDEX idx_sourcing_ev_dedup    RENAME TO idx_sce_dedup;
ALTER INDEX idx_sourcing_vr_pk       RENAME TO idx_scv_pk;
ALTER INDEX idx_sourcing_vr_verdict  RENAME TO idx_scv_verdict;
ALTER INDEX idx_sourcing_vr_recheck  RENAME TO idx_scv_recheck;
ALTER INDEX idx_sourcing_vr_entity   RENAME TO idx_scv_entity;
ALTER INDEX idx_sourcing_vr_type     RENAME TO idx_scv_type;

COMMIT;

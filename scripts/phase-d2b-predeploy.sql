-- Phase D2b Pre-Deploy SQL
-- Run this via psql BEFORE deploying the Phase D2b migration.
-- It verifies that all 8 tables have 100% integer ID coverage before
-- the _old columns are physically dropped.
--
-- Usage:
--   psql $DATABASE_URL -f scripts/phase-d2b-predeploy.sql

BEGIN;

-- Verify 0 rows have NULL page_id_int in citation_accuracy_snapshots
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM citation_accuracy_snapshots
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % citation_accuracy_snapshots rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All citation_accuracy_snapshots rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in edit_logs
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM edit_logs
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % edit_logs rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All edit_logs rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in hallucination_risk_snapshots
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM hallucination_risk_snapshots
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % hallucination_risk_snapshots rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All hallucination_risk_snapshots rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in auto_update_results
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM auto_update_results
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % auto_update_results rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All auto_update_results rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in claim_page_references
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM claim_page_references
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % claim_page_references rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All claim_page_references rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in page_improve_runs
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM page_improve_runs
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % page_improve_runs rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All page_improve_runs rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL page_id_int in page_citations
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM page_citations
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % page_citations rows have NULL page_id_int. Integer FK not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All page_citations rows have page_id_int populated.';
END $$;

-- Verify 0 rows have NULL source_id_int or target_id_int in page_links
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM page_links
  WHERE source_id_int IS NULL OR target_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % page_links rows have NULL source_id_int or target_id_int. Integer FKs not fully populated.', null_count;
  END IF;
  RAISE NOTICE 'OK: All page_links rows have source_id_int and target_id_int populated.';
END $$;

COMMIT;

-- Summary
DO $$
BEGIN
  RAISE NOTICE 'Phase D2b pre-deploy checks passed. Safe to run migration 0053_drop_old_page_id_columns.sql.';
END $$;

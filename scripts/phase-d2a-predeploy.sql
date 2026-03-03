-- Phase D2a Pre-Deploy SQL
-- Run this via psql BEFORE deploying the Phase D2a code changes.
--
-- 1. Verifies integer IDs are fully populated in page_links
-- 2. Drops NOT NULL constraints from page_id_old columns being stopped from writes
-- 3. Creates the new unique index on page_links integer columns (required by new ON CONFLICT)
--
-- Usage:
--   psql $DATABASE_URL -f scripts/phase-d2a-predeploy.sql

BEGIN;

-- Verify 0 rows have NULL integer IDs in page_links (must pass before continuing)
DO $$
DECLARE
  null_count integer;
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM page_links
  WHERE source_id_int IS NULL OR target_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % page_links rows have NULL source_id_int or target_id_int. Verify Phase B dual-write is complete.', null_count;
  END IF;
  RAISE NOTICE 'OK: All page_links rows have integer IDs populated.';

  -- Check for duplicate (source_id_int, target_id_int, link_type) groups that would
  -- prevent the CONCURRENTLY unique index from being created after COMMIT.
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT source_id_int, target_id_int, link_type
    FROM page_links
    GROUP BY source_id_int, target_id_int, link_type
    HAVING COUNT(*) > 1
  ) dupes;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % duplicate (source_id_int, target_id_int, link_type) groups in page_links. Resolve duplicates before creating the unique index.', dup_count;
  END IF;
  RAISE NOTICE 'OK: No duplicate (source_id_int, target_id_int, link_type) groups in page_links.';
END $$;

-- Drop NOT NULL from page_id_old columns whose write paths are being removed.
-- These columns become nullable until they are fully dropped in Phase D2b.
-- Tables with PKs on _old columns (citation_quotes, session_pages, resource_citations)
-- are excluded — those require PK migration before dropping.

ALTER TABLE citation_accuracy_snapshots  ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE edit_logs                    ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE hallucination_risk_snapshots ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE auto_update_results          ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE claim_page_references        ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE page_improve_runs            ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE page_citations               ALTER COLUMN page_id_old  DROP NOT NULL;
ALTER TABLE page_links                   ALTER COLUMN source_id_old DROP NOT NULL;
ALTER TABLE page_links                   ALTER COLUMN target_id_old DROP NOT NULL;

COMMIT;

-- Create new unique index on integer columns (CONCURRENTLY = no lock, runs outside transaction)
-- This is required by the Phase D2a code change to ON CONFLICT (source_id_int, target_id_int, link_type)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS page_links_source_target_int_unique
  ON page_links (source_id_int, target_id_int, link_type);

-- Verify the index was created
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'page_links' AND indexname = 'page_links_source_target_int_unique';

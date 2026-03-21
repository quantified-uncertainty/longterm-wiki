-- Phase D2a Pre-Deploy SQL (Citations + Resource Citations)
-- Run this via psql BEFORE deploying the Phase D2a code changes for citation_quotes
-- and resource_citations tables.
--
-- 1. Verifies page_id_int is fully populated in both tables
-- 2. Drops NOT NULL from citation_quotes.page_id_old
-- 3. Migrates resource_citations PK from (resource_id, page_id_old) to (resource_id, page_id_int)
-- 4. Drops NOT NULL from resource_citations.page_id_old
--
-- Usage:
--   psql $DATABASE_URL -f scripts/phase-d2a-citations-predeploy.sql

BEGIN;

-- 1a. Verify 0 rows have NULL page_id_int in citation_quotes
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM citation_quotes
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % citation_quotes rows have NULL page_id_int. Backfill first.', null_count;
  END IF;
  RAISE NOTICE 'OK: All citation_quotes rows have page_id_int populated.';
END $$;

-- 1b. Verify 0 rows have NULL page_id_int in resource_citations
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM resource_citations
  WHERE page_id_int IS NULL;

  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % resource_citations rows have NULL page_id_int. Backfill first.', null_count;
  END IF;
  RAISE NOTICE 'OK: All resource_citations rows have page_id_int populated.';
END $$;

-- 2. Drop NOT NULL from citation_quotes.page_id_old
ALTER TABLE citation_quotes ALTER COLUMN page_id_old DROP NOT NULL;

-- 3. Migrate resource_citations PK: (resource_id, page_id_old) → (resource_id, page_id_int)
-- 3a. Make page_id_int NOT NULL (required for PK)
ALTER TABLE resource_citations ALTER COLUMN page_id_int SET NOT NULL;
-- 3b. Drop existing PK
ALTER TABLE resource_citations DROP CONSTRAINT resource_citations_resource_id_page_id_pk;
-- 3c. Create new PK on integer column
ALTER TABLE resource_citations ADD PRIMARY KEY (resource_id, page_id_int);
-- 3d. Drop NOT NULL from page_id_old
ALTER TABLE resource_citations ALTER COLUMN page_id_old DROP NOT NULL;

COMMIT;

-- 4. Create new unique index on citation_quotes (page_id_int, footnote)
-- CONCURRENTLY = no lock, must run outside transaction.
-- Required by the Phase D2a code change: ON CONFLICT (page_id_int, footnote)
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS citation_quotes_page_id_int_footnote_unique
  ON citation_quotes (page_id_int, footnote);

-- Verify the index was created
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'citation_quotes' AND indexname = 'citation_quotes_page_id_int_footnote_unique';

-- Verify resource_citations PK
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'resource_citations'::regclass AND contype = 'p';

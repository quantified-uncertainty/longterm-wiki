-- Phase D2a Deferred Pre-Deploy SQL
-- Run this via psql BEFORE deploying the Phase D2a deferred code changes.
--
-- Migrates PK/UNIQUE constraints for the 3 tables that were deferred from
-- PR #1543 because their _old columns are load-bearing in PKs or UNIQUE
-- constraints:
--   1. citation_quotes: UNIQUE(page_id_old, footnote) → UNIQUE(page_id_int, footnote)
--   2. session_pages:   PK(session_id, page_id_old)  → PK(session_id, page_id_int)
--   3. resource_citations: PK(resource_id, page_id_old) → PK(resource_id, page_id_int)
--
-- ORDERING: The new citation_quotes integer UNIQUE index is created CONCURRENTLY
-- (outside any transaction) BEFORE the old text-based index is dropped, so there
-- is never a window with no uniqueness guard on citation_quotes.
--
-- Usage:
--   psql $DATABASE_URL -f scripts/phase-d2a-deferred-predeploy.sql

-- ============================================================
-- Step 1: Verify 0 NULL rows in page_id_int for all 3 tables
-- (Run outside transaction so we can abort cleanly before any changes)
-- ============================================================

DO $$
DECLARE
  null_cq integer;
  null_sp integer;
  null_rc integer;
BEGIN
  SELECT COUNT(*) INTO null_cq
  FROM citation_quotes
  WHERE page_id_int IS NULL;

  IF null_cq > 0 THEN
    RAISE EXCEPTION 'ABORT: % citation_quotes rows have NULL page_id_int. Verify Phase B dual-write is complete.', null_cq;
  END IF;
  RAISE NOTICE 'OK: All citation_quotes rows have page_id_int populated (% rows checked).', (SELECT COUNT(*) FROM citation_quotes);

  SELECT COUNT(*) INTO null_sp
  FROM session_pages
  WHERE page_id_int IS NULL;

  IF null_sp > 0 THEN
    RAISE EXCEPTION 'ABORT: % session_pages rows have NULL page_id_int. Verify Phase B dual-write is complete.', null_sp;
  END IF;
  RAISE NOTICE 'OK: All session_pages rows have page_id_int populated (% rows checked).', (SELECT COUNT(*) FROM session_pages);

  SELECT COUNT(*) INTO null_rc
  FROM resource_citations
  WHERE page_id_int IS NULL;

  IF null_rc > 0 THEN
    RAISE EXCEPTION 'ABORT: % resource_citations rows have NULL page_id_int. Verify Phase B dual-write is complete.', null_rc;
  END IF;
  RAISE NOTICE 'OK: All resource_citations rows have page_id_int populated (% rows checked).', (SELECT COUNT(*) FROM resource_citations);
END $$;

-- ============================================================
-- Step 2: citation_quotes — create new integer-based UNIQUE index FIRST
-- MUST run OUTSIDE transaction (CONCURRENTLY requires no transaction)
-- Creating this BEFORE dropping the old index ensures no uniqueness gap.
-- ============================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS citation_quotes_page_id_int_footnote_unique
  ON citation_quotes (page_id_int, footnote);

-- ============================================================
-- Step 3: Swap constraints inside a transaction (old index/PKs dropped here)
-- ============================================================

BEGIN;

-- session_pages — swap PK to (session_id, page_id_int)
-- Drop the old text-based PK (named session_pages_session_id_page_id_pk in production)
ALTER TABLE session_pages DROP CONSTRAINT IF EXISTS session_pages_pkey;
ALTER TABLE session_pages DROP CONSTRAINT IF EXISTS session_pages_session_id_page_id_pk;

-- Add new integer-based PK
ALTER TABLE session_pages ADD PRIMARY KEY (session_id, page_id_int);

-- Drop NOT NULL from old text column (now optional)
ALTER TABLE session_pages ALTER COLUMN page_id_old DROP NOT NULL;

-- resource_citations — swap PK to (resource_id, page_id_int)
-- Drop the old text-based PK (named resource_citations_resource_id_page_id_pk in production)
ALTER TABLE resource_citations DROP CONSTRAINT IF EXISTS resource_citations_pkey;
ALTER TABLE resource_citations DROP CONSTRAINT IF EXISTS resource_citations_resource_id_page_id_pk;

-- Add new integer-based PK
ALTER TABLE resource_citations ADD PRIMARY KEY (resource_id, page_id_int);

-- Drop NOT NULL from old text column (now optional)
ALTER TABLE resource_citations ALTER COLUMN page_id_old DROP NOT NULL;

-- citation_quotes — drop old UNIQUE index (new one already created above) and drop NOT NULL
-- The new integer-based UNIQUE index already exists from Step 2.
DROP INDEX IF EXISTS citation_quotes_page_id_footnote_unique;

-- Drop NOT NULL from old text column (now optional)
ALTER TABLE citation_quotes ALTER COLUMN page_id_old DROP NOT NULL;

COMMIT;

-- ============================================================
-- Step 4: Verify indexes/constraints were created successfully
-- ============================================================

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'citation_quotes'
  AND indexname = 'citation_quotes_page_id_int_footnote_unique';

SELECT
  conname,
  contype,
  pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'session_pages'::regclass
  AND conname = 'session_pages_pkey';

SELECT
  conname,
  contype,
  pg_get_constraintdef(oid) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'resource_citations'::regclass
  AND conname = 'resource_citations_pkey';

-- Phase D3+E: Swap wiki_pages PK from text to integer, rename all _int columns.
-- This is a no-op Drizzle migration. The actual DDL is in:
--   scripts/phase-d3e-pk-swap.sql
-- Run the manual script via psql BEFORE deploying the code changes.
-- See Discussion #1497 Phase D3+E for context.
-- Guard: on production DBs where the manual PK swap hasn't been run yet, fail early.
-- On fresh/test DBs (no rows in wiki_pages), skip the guard — migrations create the
-- correct schema from scratch.
DO $$
BEGIN
  -- Only check if wiki_pages has data (i.e., this is a production DB, not a fresh test DB)
  IF EXISTS (SELECT 1 FROM wiki_pages LIMIT 1) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wiki_pages'
        AND column_name = 'integer_id'
    ) OR EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'wiki_pages'
        AND column_name = 'id'
        AND data_type <> 'integer'
    ) THEN
      RAISE EXCEPTION
        'Run scripts/phase-d3e-pk-swap.sql before applying drizzle migration 0128';
    END IF;
  END IF;
END $$;

SELECT 1;

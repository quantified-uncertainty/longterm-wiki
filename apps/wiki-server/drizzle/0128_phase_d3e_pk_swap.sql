-- Phase D3+E: Swap wiki_pages PK from text to integer, rename all _int columns.
-- This is a no-op Drizzle migration. The actual DDL is in:
--   scripts/phase-d3e-pk-swap.sql
-- Run the manual script via psql BEFORE deploying the code changes.
-- See Discussion #1497 Phase D3+E for context.
DO $$
BEGIN
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
      'Run scripts/phase-d3e-pk-swap.sql before applying drizzle migration 0125';
  END IF;
END $$;

SELECT 1;

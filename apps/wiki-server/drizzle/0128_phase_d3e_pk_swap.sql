-- Phase D3+E: Swap wiki_pages PK from text to integer, rename all _int columns.
-- This is a no-op Drizzle migration. The actual DDL is in:
--   scripts/phase-d3e-pk-swap.sql
-- Run the manual script via psql BEFORE deploying the code changes.
-- See Discussion #1497 Phase D3+E for context.
SELECT 1;

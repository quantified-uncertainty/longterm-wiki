-- QUA-507 Phase 4b-B.2c: drop denormalized columns from `things` and stop
-- writing them. This is the final phase of the QUA-408 `things`
-- denormalization unwind. Readers already switched to the `things_search`
-- materialized view in QUA-506 (migration 0181, rebuilt in 0190).
--
-- Required drop order (generated-column dependency):
--   1. search_vector (GENERATED ALWAYS AS (... title, description, parent_title ...))
--   2. title / description / parent_title (referenced by search_vector)
--
-- Reversibility: this migration is not cleanly reversible. The 7-day bake
-- window on migration 0181/0190 was the safety net. If a revert is needed,
-- the columns must be repopulated from source tables via the same joins as
-- the `things_search` MV definition (see drizzle/0190_qua_567_rebuild_things_search_mv.sql).

-- Drop the GIN index that backed the generated column.
DROP INDEX IF EXISTS idx_things_search;

-- Drop the generated search_vector column first (it depends on title, description, parent_title).
ALTER TABLE things DROP COLUMN IF EXISTS search_vector;

-- Drop the three denormalized display columns. They are now computed in the
-- `things_search` MV from source tables.
ALTER TABLE things DROP COLUMN IF EXISTS title;
ALTER TABLE things DROP COLUMN IF EXISTS description;
ALTER TABLE things DROP COLUMN IF EXISTS parent_title;

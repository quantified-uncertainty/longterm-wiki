-- Drop the redundant non-unique index on (source_table, source_id).
-- The unique index idx_things_source_unique already covers all queries
-- that idx_things_source would serve, making it unnecessary overhead.
DROP INDEX IF EXISTS idx_things_source;

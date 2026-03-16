-- No-op: actual MV creation is in scripts/create-related-graph-mv.sql
-- because it depends on source_id_int / target_id_int columns added by
-- manual migration (phase4a-manual-migration.sql), not by Drizzle.
-- The CI test DB doesn't have those columns, so this must be a no-op.
SELECT 1;

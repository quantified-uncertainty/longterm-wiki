-- No-op: actual migration is in apps/wiki-server/scripts/0141-normalize-stableids.sql
--
-- This migration normalizes 85 contaminated stableIds (containing base64url chars - and _)
-- to clean [A-Za-z0-9]{10} format across all tables referencing entities.stableId.
--
-- It uses SET session_replication_role = replica to disable FK triggers during bulk
-- PK updates. This requires superuser or REPLICATION role on the database connection,
-- which the standard Drizzle migration runner may not have.
--
-- Apply manually:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/0141-normalize-stableids.sql
--
-- Verify after applying:
--   SELECT stable_id FROM entities WHERE stable_id ~ '[-_]';
--   -- Should return 0 rows.

SELECT 1;

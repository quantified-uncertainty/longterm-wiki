-- Backfill stable_id for resources that don't have one yet.
-- Generates 10-char alphanumeric IDs using encode(gen_random_bytes(7), 'base64').
-- Run after deploying migration 0071.
--
-- Usage: psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-resource-stable-ids.sql
--
-- Idempotent: only updates rows where stable_id IS NULL.

DO $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE resources
  SET stable_id = left(
    replace(replace(encode(gen_random_bytes(7), 'base64'), '+', '0'), '/', '1'),
    10
  )
  WHERE stable_id IS NULL;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'Backfilled stable_id for % resources', rows_updated;
END $$;

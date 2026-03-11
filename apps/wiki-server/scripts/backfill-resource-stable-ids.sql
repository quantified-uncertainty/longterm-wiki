-- Backfill stable_id for resources that don't have one yet.
-- Generates 10-char alphanumeric IDs from random bytes.
-- Run after deploying migration 0071.
--
-- Usage: psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-resource-stable-ids.sql
--
-- Idempotent: only updates rows where stable_id IS NULL.
-- Character set: matches Node.js generateId() — alphanumeric (a-z, A-Z, 0-9).
-- Non-alphanumeric chars (+, /, =, -, _) are replaced with deterministic
-- alphanumeric substitutes to avoid bias toward any single character.

DO $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE resources
  SET stable_id = left(
    translate(
      encode(gen_random_bytes(7), 'base64'),
      '+/=-_',
      'abcde'
    ),
    10
  )
  WHERE stable_id IS NULL;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'Backfilled stable_id for % resources', rows_updated;
END $$;

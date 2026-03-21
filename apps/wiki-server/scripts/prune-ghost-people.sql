-- One-time cleanup: remove ghost duplicate people entities from PG.
--
-- These entities were created by personnel enrichment tasks with garbled or
-- inverted slug IDs. The correct entries exist under their canonical IDs
-- (amanda-askell, samuel-r-bowman, etc.) in data/entities/people.yaml.
--
-- The regular sync-entities + prune pipeline should prevent this from
-- recurring, but these ghosts predate the prune step.
--
-- Usage:
--   psql "$DATABASE_URL" -f apps/wiki-server/scripts/prune-ghost-people.sql
--
-- Idempotent: safe to run multiple times.
--
-- Related: GitHub issue #2796

BEGIN;

-- Ghost slug IDs to remove (duplicates of canonical entries)
-- askell-amanda     → dup of amanda-askell
-- bowman-samuel-r   → dup of samuel-r-bowman
-- andrew-y-ng       → dup of andrew-ng
-- andreas-stuhlm-ller → dup of andreas-stuhlmuller
-- alex-kaskasoli    → dup of alexandre-kaskasoli
-- buck              → dup of buck-shlegeris
-- algon             → data import artifact (no canonical entry)

-- 1. Delete from things table first (FK references entities via source_id)
DELETE FROM things
WHERE source_table = 'entities'
  AND source_id IN (
    'askell-amanda',
    'bowman-samuel-r',
    'andrew-y-ng',
    'andreas-stuhlm-ller',
    'alex-kaskasoli',
    'buck',
    'algon'
  );

-- 2. Delete from entities table
DELETE FROM entities
WHERE id IN (
    'askell-amanda',
    'bowman-samuel-r',
    'andrew-y-ng',
    'andreas-stuhlm-ller',
    'alex-kaskasoli',
    'buck',
    'algon'
  );

COMMIT;

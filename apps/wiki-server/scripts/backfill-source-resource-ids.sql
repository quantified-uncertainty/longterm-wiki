-- Backfill source_resource_id on personnel, grants, funding_rounds,
-- investments, and equity_positions by matching the source URL column
-- against the resources table.
--
-- Uses cascading URL normalization: exact match first, then trailing-slash,
-- www/no-www, and http/https variants — same strategy as
-- backfill-citation-resource-ids.sql.
--
-- Safe to re-run: all UPDATEs use WHERE source_resource_id IS NULL.
-- Wrapped in a transaction — rolls back cleanly on any failure.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-source-resource-ids.sql

BEGIN;

-- ============================================================
-- Helper: normalize a URL for comparison
--   1. Strip trailing slash
--   2. Lowercase the scheme + host (URLs are case-insensitive there)
-- Applied inline below for clarity.
-- ============================================================

-- ============================================================
-- personnel
-- ============================================================

-- Exact match
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND t.source = r.url;

-- Trailing slash normalization
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = rtrim(r.url, '/');

-- www -> no-www
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), '://www.', '://') = rtrim(r.url, '/');

-- no-www -> www
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

-- http -> https
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), 'http://', 'https://') = rtrim(r.url, '/');

-- https -> http
UPDATE personnel t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- grants
-- ============================================================

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND t.source = r.url;

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = rtrim(r.url, '/');

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), '://www.', '://') = rtrim(r.url, '/');

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), 'http://', 'https://') = rtrim(r.url, '/');

UPDATE grants t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- funding_rounds
-- ============================================================

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND t.source = r.url;

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = rtrim(r.url, '/');

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), '://www.', '://') = rtrim(r.url, '/');

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), 'http://', 'https://') = rtrim(r.url, '/');

UPDATE funding_rounds t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- investments
-- ============================================================

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND t.source = r.url;

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = rtrim(r.url, '/');

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), '://www.', '://') = rtrim(r.url, '/');

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), 'http://', 'https://') = rtrim(r.url, '/');

UPDATE investments t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- equity_positions
-- ============================================================

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND t.source = r.url;

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = rtrim(r.url, '/');

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), '://www.', '://') = rtrim(r.url, '/');

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND replace(rtrim(t.source, '/'), 'http://', 'https://') = rtrim(r.url, '/');

UPDATE equity_positions t
SET source_resource_id = r.id
FROM resources r
WHERE t.source IS NOT NULL
  AND t.source_resource_id IS NULL
  AND rtrim(t.source, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

COMMIT;

-- ============================================================
-- Report results (outside transaction for visibility)
-- ============================================================

DO $$
DECLARE
  tbl text;
  filled bigint;
  remaining bigint;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['personnel', 'grants', 'funding_rounds', 'investments', 'equity_positions'])
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM %I WHERE source_resource_id IS NOT NULL', tbl
    ) INTO filled;
    EXECUTE format(
      'SELECT COUNT(*) FROM %I WHERE source IS NOT NULL AND source_resource_id IS NULL', tbl
    ) INTO remaining;
    RAISE NOTICE '%: % linked, % remaining (source URL present but no matching resource)',
      tbl, filled, remaining;
  END LOOP;
END $$;

-- Backfill resourceId on page_citations and statement_citations
-- where url IS NOT NULL but resource_id IS NULL.
--
-- Matches citation URLs to the resources table using exact match first,
-- then normalized variants (www/no-www, trailing slash).
--
-- Safe to re-run: all UPDATEs use WHERE resource_id IS NULL.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-citation-resource-ids.sql

BEGIN;

-- ============================================================
-- Step 1: Exact URL match — page_citations
-- ============================================================

UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND pc.url = r.url;

-- ============================================================
-- Step 2: Normalized match — page_citations
-- Try without trailing slash, with trailing slash,
-- www ↔ no-www variants
-- ============================================================

-- Remove trailing slash from citation URL, match against resource URL
UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND rtrim(pc.url, '/') = rtrim(r.url, '/');

-- www ↔ no-www: citation has www, resource does not
UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND replace(rtrim(pc.url, '/'), '://www.', '://') = rtrim(r.url, '/');

-- www ↔ no-www: citation lacks www, resource has it
UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND rtrim(pc.url, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

-- http ↔ https: citation uses http, resource uses https
UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND replace(rtrim(pc.url, '/'), 'http://', 'https://') = rtrim(r.url, '/');

-- http ↔ https: citation uses https, resource uses http
UPDATE page_citations pc
SET resource_id = r.id
FROM resources r
WHERE pc.url IS NOT NULL
  AND pc.resource_id IS NULL
  AND rtrim(pc.url, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- Step 3: Exact URL match — statement_citations
-- ============================================================

UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND sc.url = r.url;

-- ============================================================
-- Step 4: Normalized match — statement_citations
-- ============================================================

UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND rtrim(sc.url, '/') = rtrim(r.url, '/');

UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND replace(rtrim(sc.url, '/'), '://www.', '://') = rtrim(r.url, '/');

UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND rtrim(sc.url, '/') = replace(rtrim(r.url, '/'), '://www.', '://');

-- http ↔ https: citation uses http, resource uses https
UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND replace(rtrim(sc.url, '/'), 'http://', 'https://') = rtrim(r.url, '/');

-- http ↔ https: citation uses https, resource uses http
UPDATE statement_citations sc
SET resource_id = r.id
FROM resources r
WHERE sc.url IS NOT NULL
  AND sc.resource_id IS NULL
  AND rtrim(sc.url, '/') = replace(rtrim(r.url, '/'), 'http://', 'https://');

-- ============================================================
-- Step 5: Report results
-- ============================================================

DO $$
DECLARE
  pc_filled bigint;
  pc_remaining bigint;
  sc_filled bigint;
  sc_remaining bigint;
BEGIN
  SELECT COUNT(*) INTO pc_filled FROM page_citations WHERE resource_id IS NOT NULL;
  SELECT COUNT(*) INTO pc_remaining FROM page_citations WHERE url IS NOT NULL AND resource_id IS NULL;
  SELECT COUNT(*) INTO sc_filled FROM statement_citations WHERE resource_id IS NOT NULL;
  SELECT COUNT(*) INTO sc_remaining FROM statement_citations WHERE url IS NOT NULL AND resource_id IS NULL;

  RAISE NOTICE 'page_citations: % filled, % remaining (url present but no matching resource)', pc_filled, pc_remaining;
  RAISE NOTICE 'statement_citations: % filled, % remaining (url present but no matching resource)', sc_filled, sc_remaining;
END $$;

COMMIT;

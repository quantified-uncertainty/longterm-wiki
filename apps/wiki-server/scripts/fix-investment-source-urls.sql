-- fix-investment-source-urls.sql
--
-- Manual migration script to fix investment records that all point to the wrong
-- source URL (an SB 1047 article instead of actual investment data sources).
--
-- Context: GitHub issue #3659, Discussion #3567
-- 50 of 56 investment records (89%) were marked unverifiable because they share
-- incorrect source URLs pointing to SB 1047-related articles instead of actual
-- investment data sources (Crunchbase, press releases, SEC filings, etc.).
--
-- The Drizzle migration 0151_fix_investment_source_urls.sql handles the two
-- known bad URLs. This manual script is a more thorough safety net that:
--   1. Clears the known bad SB 1047 URLs explicitly (idempotent with migration 0151)
--   2. Clears any source URL shared by >= 5 investment records (bulk-assigned by mistake)
--   3. Cleans up the `things` table mirror of these source URLs
--   4. Clears stale source_check_evidence and source_check_verdicts
--
-- Idempotent: safe to run multiple times. NULLing an already-NULL column is a no-op.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/fix-investment-source-urls.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Diagnostic: show current state before changes
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  total_inv integer;
  with_source integer;
  bad_url_count integer;
  bulk_url_count integer;
BEGIN
  SELECT COUNT(*) INTO total_inv FROM investments;
  SELECT COUNT(*) INTO with_source FROM investments WHERE source IS NOT NULL AND source != '';

  SELECT COUNT(*) INTO bad_url_count
  FROM investments
  WHERE source IN (
    'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
    'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
  );

  SELECT COALESCE(SUM(cnt), 0) INTO bulk_url_count
  FROM (
    SELECT COUNT(*) AS cnt
    FROM investments
    WHERE source IS NOT NULL
      AND source NOT IN (
        'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
        'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
      )
    GROUP BY source
    HAVING COUNT(*) >= 5
  ) sub;

  RAISE NOTICE '=== Pre-fix State ===';
  RAISE NOTICE 'Total investments: %', total_inv;
  RAISE NOTICE 'With source URL: %', with_source;
  RAISE NOTICE 'With known bad SB 1047 URLs: %', bad_url_count;
  RAISE NOTICE 'With other bulk-assigned URLs (>= 5 sharing): %', bulk_url_count;
  RAISE NOTICE '';
END $$;

-- ---------------------------------------------------------------------------
-- Step 1: Clear known bad SB 1047 URLs
-- ---------------------------------------------------------------------------

-- These two URLs were bulk-assigned to investment records by an LLM agent
-- that used California AI regulation articles as sources for unrelated
-- investment records.

UPDATE investments
SET source = NULL, updated_at = now()
WHERE source IN (
  'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
  'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
);

-- ---------------------------------------------------------------------------
-- Step 2: Clear any remaining source URL shared by >= 5 investment records
-- ---------------------------------------------------------------------------
-- This catches any other bulk-assigned URLs we might have missed.
-- The threshold of 5 is conservative: legitimate source URLs are rarely
-- shared by more than 2-3 records (e.g., a press release covering one round
-- with multiple investors). Having 5+ records pointing to the same URL
-- strongly suggests a pipeline bug.

UPDATE investments
SET source = NULL, updated_at = now()
WHERE source IN (
  SELECT source
  FROM investments
  WHERE source IS NOT NULL
  GROUP BY source
  HAVING COUNT(*) >= 5
);

-- ---------------------------------------------------------------------------
-- Step 3: Clean up the things table mirror
-- ---------------------------------------------------------------------------
-- The investments sync route dual-writes source URLs to the things table
-- (via upsertThingsInTx). These need to be cleared too.

UPDATE things
SET source_url = NULL, updated_at = now()
WHERE source_table = 'investments'
  AND thing_type = 'investment'
  AND source_url IS NOT NULL
  AND id IN (
    SELECT id FROM investments WHERE source IS NULL
  );

-- ---------------------------------------------------------------------------
-- Step 4: Clear stale source_check_evidence for investments
-- ---------------------------------------------------------------------------
-- Evidence rows checked against the wrong URLs are misleading. Delete them
-- so the records can be re-checked with correct (or no) source URLs.
-- We clear ALL evidence for investment records that now have NULL source,
-- since any previous checks were against the wrong URL.

DELETE FROM source_check_evidence
WHERE record_type = 'investment'
  AND record_id IN (
    SELECT id FROM investments WHERE source IS NULL
  );

-- ---------------------------------------------------------------------------
-- Step 5: Clear orphaned source_check_verdicts for investments
-- ---------------------------------------------------------------------------
-- Verdicts are derived from evidence. If all evidence for a record was
-- deleted, the verdict is stale and should be removed.

DELETE FROM source_check_verdicts
WHERE record_type = 'investment'
  AND record_id NOT IN (
    SELECT DISTINCT record_id
    FROM source_check_evidence
    WHERE record_type = 'investment'
  );

-- ---------------------------------------------------------------------------
-- Summary report
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  total_inv integer;
  with_source integer;
  without_source integer;
  remaining_evidence integer;
  remaining_verdicts integer;
BEGIN
  SELECT COUNT(*) INTO total_inv FROM investments;
  SELECT COUNT(*) INTO with_source FROM investments WHERE source IS NOT NULL AND source != '';
  without_source := total_inv - with_source;

  SELECT COUNT(*) INTO remaining_evidence
  FROM source_check_evidence WHERE record_type = 'investment';

  SELECT COUNT(*) INTO remaining_verdicts
  FROM source_check_verdicts WHERE record_type = 'investment';

  RAISE NOTICE '=== Post-fix State ===';
  RAISE NOTICE 'Total investment records: %', total_inv;
  RAISE NOTICE 'With source URL: %', with_source;
  RAISE NOTICE 'Without source URL (need re-sourcing): %', without_source;
  RAISE NOTICE 'Remaining source_check_evidence rows: %', remaining_evidence;
  RAISE NOTICE 'Remaining source_check_verdicts rows: %', remaining_verdicts;
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '  1. Re-run source-check: pnpm crux tb source-check-records --table=investments';
  RAISE NOTICE '  2. Use enrichment to find correct source URLs: pnpm crux tb enrich --task=investment-linking';
END $$;

COMMIT;

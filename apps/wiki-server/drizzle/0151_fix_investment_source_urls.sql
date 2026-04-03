-- Fix 44 investment records that all point to the same wrong source URL.
-- These were created by an LLM agent that used a California AI regulation article
-- as the source for unrelated investment records.
-- Also fix 3 investments pointing to the a16z SB 1047 podcast URL.
-- Setting source to NULL so they can be re-verified with web search.
--
-- Context: GitHub issue #3659, Discussion #3567
-- See also: apps/wiki-server/scripts/fix-investment-source-urls.sql (manual, more thorough)

UPDATE investments
SET source = NULL, updated_at = now()
WHERE source IN (
  'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
  'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
);

-- Also clear the things table mirror of these source URLs.
-- The investments sync route dual-writes source URLs to things via upsertThingsInTx.
UPDATE things
SET source_url = NULL, updated_at = now()
WHERE source_table = 'investments'
  AND thing_type = 'investment'
  AND source_url IN (
    'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
    'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
  );

-- Clear stale source-check evidence and verdicts for these investments
-- so they don't display old results against the now-removed URLs.
DELETE FROM source_check_evidence
WHERE record_type = 'investment'
  AND source_url IN (
    'https://www.transformernews.ai/p/a16z-y-combinator-big-tech-sb1047-lobbying',
    'https://a16z.com/sb-1047-what-you-need-to-know-with-anjney-midha/'
  );

DELETE FROM source_check_verdicts
WHERE record_type = 'investment'
  AND record_id NOT IN (
    SELECT DISTINCT record_id FROM source_check_evidence WHERE record_type = 'investment'
  );

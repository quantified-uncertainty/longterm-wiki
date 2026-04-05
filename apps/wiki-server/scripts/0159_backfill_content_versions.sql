-- Backfill resource_content_versions from existing citation_content.
--
-- Run AFTER migration 0159 creates the table:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/0159_backfill_content_versions.sql
--
-- Idempotent: ON CONFLICT DO NOTHING skips already-backfilled rows.
-- Only copies rows where both content_hash and full_text are NOT NULL
-- (hash without content is a broken invariant; content without hash
-- will get versioned on next fetch via the dual-write path).

INSERT INTO resource_content_versions (
  resource_id, url, content_hash, fetched_at, content, content_length,
  http_status, content_type, fetch_method, metadata, created_at
)
SELECT
  cc.resource_id,
  cc.url,
  cc.content_hash,
  cc.fetched_at,
  cc.full_text,
  cc.content_length,
  cc.http_status,
  cc.content_type,
  cc.fetch_method,
  jsonb_strip_nulls(jsonb_build_object(
    'pageTitle', cc.page_title,
    'fullTextPreview', cc.full_text_preview
  )),
  cc.created_at
FROM citation_content cc
WHERE cc.content_hash IS NOT NULL
  AND cc.full_text IS NOT NULL
ON CONFLICT (url, content_hash) DO NOTHING;

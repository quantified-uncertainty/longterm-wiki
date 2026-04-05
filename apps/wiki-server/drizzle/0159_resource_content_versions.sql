-- Resource Content Versions — unified append-only content history for all resources.
-- Replaces the split between citation_content (latest-only web pages) and
-- source_snapshots (versioned tabular data). Both content types go here.
--
-- citation_content remains as a "latest content" hot cache (zero consumer breakage).
-- This table adds temporal depth with content-hash dedup.

CREATE TABLE IF NOT EXISTS resource_content_versions (
  id              bigserial PRIMARY KEY,
  resource_id     text REFERENCES resources(id) ON DELETE SET NULL,
  url             text NOT NULL,
  content_hash    text NOT NULL,
  fetched_at      timestamptz NOT NULL,
  content         text,
  content_length  integer,
  http_status     integer,
  content_type    text,
  fetch_method    text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Content-hash dedup: same URL + same content hash = same version
CREATE UNIQUE INDEX IF NOT EXISTS idx_rcv_url_hash
  ON resource_content_versions (url, content_hash);

-- Temporal queries: "all versions of this URL, newest first"
CREATE INDEX IF NOT EXISTS idx_rcv_url_fetched
  ON resource_content_versions (url, fetched_at DESC);

-- Resource lookups
CREATE INDEX IF NOT EXISTS idx_rcv_resource_id
  ON resource_content_versions (resource_id);

-- Retention/cleanup queries
CREATE INDEX IF NOT EXISTS idx_rcv_fetched_at
  ON resource_content_versions (fetched_at);

-- Backfill from existing citation_content (one version per URL).
-- Web-page-specific fields go into metadata JSONB.
-- Only backfill rows that have a content_hash (required for dedup constraint).
-- Rows without content_hash will get versioned on next fetch via the dual-write path.
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
ON CONFLICT (url, content_hash) DO NOTHING;

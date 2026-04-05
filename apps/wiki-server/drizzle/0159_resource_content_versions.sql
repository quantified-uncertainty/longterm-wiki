-- Resource Content Versions — unified append-only content history for all resources.
-- Replaces the split between citation_content (latest-only web pages) and
-- source_snapshots (versioned tabular data). Both content types go here.
--
-- citation_content remains as a "latest content" hot cache (zero consumer breakage).
-- This table adds temporal depth with content-hash dedup.
--
-- NOTE: Backfill is in a separate manual script (apps/wiki-server/scripts/0159_backfill_content_versions.sql)
-- because copying full_text blobs across thousands of rows may exceed statement_timeout.
-- See database-migrations.md for the manual migration pattern.

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
  ON resource_content_versions (url, fetched_at);

-- Resource lookups
CREATE INDEX IF NOT EXISTS idx_rcv_resource_id
  ON resource_content_versions (resource_id);

-- Retention/cleanup queries
CREATE INDEX IF NOT EXISTS idx_rcv_fetched_at
  ON resource_content_versions (fetched_at);

-- Build metrics: coverage, rankings, update schedule, page similarity
-- These metrics are computed by build-data.mjs and synced to PG for
-- historical tracking and dashboard access without rebuilding.

-- 1. Add coverage + schedule + ranking columns to wiki_pages
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_passing INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_total INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_items JSONB;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS update_frequency INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS days_since_update INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS days_until_due INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS staleness REAL;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS update_priority REAL;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS reader_rank INTEGER;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS research_rank INTEGER;

-- 2. Create page similarity table (top-N per page, not full O(n^2))
CREATE TABLE IF NOT EXISTS wikibase_page_similarity (
  id            BIGSERIAL PRIMARY KEY,
  page_id_int   INTEGER,  -- references wiki_pages(integer_id); no FK (Phase 4a convention)
  similar_page_id_int INTEGER,  -- references wiki_pages(integer_id); no FK
  similarity    INTEGER NOT NULL,  -- 0-100 percentage
  rank          INTEGER NOT NULL,  -- 1-5 (position among top similar pages)
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookups by page
CREATE INDEX IF NOT EXISTS idx_wps_page_id ON wikibase_page_similarity (page_id_int);
-- Unique constraint to enable upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_wps_page_rank ON wikibase_page_similarity (page_id_int, rank);

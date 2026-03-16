-- Migration: Add content metrics columns to wiki_pages and create page_similarity table
-- Supports syncing coverage, update schedule, structural metrics, and content similarity
-- from the build pipeline to PG (issue #2434, Epic #2428 PG-First Migration).

-- ============================================================================
-- 1. Coverage columns on wiki_pages
-- ============================================================================
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_passing integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_total integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS coverage_items jsonb;

-- ============================================================================
-- 2. Update schedule columns on wiki_pages
-- ============================================================================
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS update_frequency integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS days_since_update integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS days_until_due integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS staleness real;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS update_priority real;

-- ============================================================================
-- 3. Structural metrics columns on wiki_pages
-- ============================================================================
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS section_count integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS table_count integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS diagram_count integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS footnote_count integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS internal_links integer;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS external_links integer;

-- ============================================================================
-- 4. Page similarity table — stores top N similar pages per page
-- ============================================================================
CREATE TABLE IF NOT EXISTS wikibase_page_similarity (
  id bigserial PRIMARY KEY,
  page_id text NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  similar_page_id text NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  similarity real NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

-- Named to match Drizzle schema's uniqueIndex("idx_page_similarity_pair")
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_similarity_pair ON wikibase_page_similarity(page_id, similar_page_id);
CREATE INDEX IF NOT EXISTS idx_page_similarity_page_id ON wikibase_page_similarity(page_id);
CREATE INDEX IF NOT EXISTS idx_page_similarity_similar_page_id ON wikibase_page_similarity(similar_page_id);
CREATE INDEX IF NOT EXISTS idx_page_similarity_similarity ON wikibase_page_similarity(similarity DESC);

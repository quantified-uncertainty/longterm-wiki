-- Add parent_title column to the things table for search.
-- parent_title: denormalized parent entity name (e.g., org name for a grant).
-- Indexed in the search_vector so "Anthropic Series E" matches a funding round
-- titled "Series E" with parent_title "Anthropic".
--
-- href is NOT stored — it's computed at query time from thing_type + source_id
-- to avoid staleness when routes change.

ALTER TABLE things ADD COLUMN IF NOT EXISTS parent_title TEXT;

-- Recreate the generated search_vector to include parent_title.
-- Must DROP first because Postgres does not allow ALTER on generated columns.
ALTER TABLE things DROP COLUMN IF EXISTS search_vector;
ALTER TABLE things ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(parent_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED;

-- Recreate GIN index (dropped with the column)
CREATE INDEX IF NOT EXISTS idx_things_search ON things USING GIN(search_vector);

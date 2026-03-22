-- Add tsvector search_vector column to entities table for full-text search.
-- Uses the same generated-column pattern as the things table (migration 0086/0113).
-- Title gets weight A, description gets weight B for relevance ranking.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_entities_search ON entities USING GIN(search_vector);

-- Also enable the pg_trgm extension for trigram fallback (idempotent).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram index on title for typo-tolerant fallback search.
CREATE INDEX IF NOT EXISTS idx_entities_title_trgm ON entities USING GIN(title gin_trgm_ops);

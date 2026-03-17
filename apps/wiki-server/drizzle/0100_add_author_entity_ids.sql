-- Add author_entity_ids column to resources table.
-- Stores entity stableIds of matched authors, populated by `crux people link-resources`.
-- This enables querying "all publications by person X" without name matching at runtime.

ALTER TABLE resources ADD COLUMN IF NOT EXISTS author_entity_ids jsonb;

-- GIN index for efficient containment queries (@> operator)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_res_author_entity_ids
  ON resources USING gin (author_entity_ids);

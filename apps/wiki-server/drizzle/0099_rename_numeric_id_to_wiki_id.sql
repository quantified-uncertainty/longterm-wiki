-- Rename numeric_id → wiki_id across all tables.
-- This is a metadata-only operation (no data movement), safe for large tables.
-- All consumers (TypeScript types, Drizzle schema, queries) updated in the same PR.

ALTER TABLE entity_ids RENAME COLUMN numeric_id TO wiki_id;
ALTER TABLE wiki_pages RENAME COLUMN numeric_id TO wiki_id;
ALTER TABLE entities RENAME COLUMN numeric_id TO wiki_id;
ALTER TABLE things RENAME COLUMN numeric_id TO wiki_id;
ALTER TABLE research_areas RENAME COLUMN numeric_id TO wiki_id;

-- Rename indexes to match
ALTER INDEX idx_wp_numeric_id RENAME TO idx_wp_wiki_id;
ALTER INDEX idx_ent_numeric_id RENAME TO idx_ent_wiki_id;

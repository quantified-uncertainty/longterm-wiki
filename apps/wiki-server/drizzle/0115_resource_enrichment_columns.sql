-- Migration 0115: Add enrichment columns to resources table
-- Adds context_note, resource_purpose, resource_subtype, type_metadata,
-- publisher_entity_id, related_entity_ids, enrichment_status, enrichment_date,
-- importance_score. All nullable, backward compatible.

ALTER TABLE resources ADD COLUMN IF NOT EXISTS context_note text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS resource_purpose text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS resource_subtype text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS type_metadata jsonb;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS publisher_entity_id text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS related_entity_ids jsonb;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS enrichment_status text;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS enrichment_date timestamptz;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS importance_score real;

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_res_enrichment_status ON resources (enrichment_status);
CREATE INDEX IF NOT EXISTS idx_res_importance_score ON resources (importance_score);
CREATE INDEX IF NOT EXISTS idx_res_publisher_entity_id ON resources (publisher_entity_id);
CREATE INDEX IF NOT EXISTS idx_res_resource_purpose ON resources (resource_purpose);
CREATE INDEX IF NOT EXISTS idx_res_resource_subtype ON resources (resource_subtype);

-- GIN index for related_entity_ids jsonb array containment queries
CREATE INDEX IF NOT EXISTS idx_res_related_entity_ids ON resources USING gin (related_entity_ids);

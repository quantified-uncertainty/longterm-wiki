-- Add source_url column to kb_fact_resource_verifications.
-- Tracks which URL was actually verified, since the fact's source URL can change over time.

ALTER TABLE kb_fact_resource_verifications ADD COLUMN IF NOT EXISTS source_url TEXT;

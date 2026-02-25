-- Enhanced claims: multi-entity support, claim categories, fact linking, resource linking
-- This migration adds columns to support:
--   1. Claims relating to multiple entities (not just one page)
--   2. Claim category taxonomy (factual, opinion, analytical, speculative, relational)
--   3. Linking numeric claims to the facts system
--   4. Linking claims directly to resource IDs

ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_category text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS related_entities jsonb;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS fact_id text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS resource_ids jsonb;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS section text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS footnote_refs text;

-- Migrate existing data: copy section name from overloaded 'value' column to 'section'
UPDATE claims SET section = value WHERE section IS NULL AND value IS NOT NULL;

-- Migrate existing data: copy footnote refs from overloaded 'unit' column to 'footnote_refs'
UPDATE claims SET footnote_refs = unit WHERE footnote_refs IS NULL AND unit IS NOT NULL;

-- Index for multi-entity queries using GIN on JSONB
CREATE INDEX IF NOT EXISTS idx_cl_related_entities ON claims USING gin (related_entities);
CREATE INDEX IF NOT EXISTS idx_cl_claim_category ON claims (claim_category);
CREATE INDEX IF NOT EXISTS idx_cl_fact_id ON claims (fact_id);

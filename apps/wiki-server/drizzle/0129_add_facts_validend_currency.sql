-- Add validEnd and currency columns to the facts table.
-- These fields exist in the Fact YAML interface but were missing from PG.
-- Required for PG to become the source of truth for FactBase facts.
-- See discussion #2950.

ALTER TABLE facts ADD COLUMN IF NOT EXISTS valid_end TEXT;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS currency TEXT;

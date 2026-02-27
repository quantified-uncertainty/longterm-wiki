-- Migration 0037: Add metadata columns to claim_sources
--
-- Closes the schema gap between citation_quotes and claim_sources.
-- These fields exist in citation_quotes but were missing from claim_sources,
-- which prevents lossless consolidation into the claims system (#1194).

ALTER TABLE claim_sources ADD COLUMN IF NOT EXISTS source_title TEXT;
ALTER TABLE claim_sources ADD COLUMN IF NOT EXISTS source_type TEXT;
ALTER TABLE claim_sources ADD COLUMN IF NOT EXISTS source_location TEXT;

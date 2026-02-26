-- Migration 0033: Add page_citations table and extend claim_page_references
--
-- Phase 3 of DB-driven footnotes: supports both claim-backed and regular citations
-- appearing as footnotes on wiki pages, unified via a shared reference_id.

-- Add columns to claim_page_references
ALTER TABLE claim_page_references ADD COLUMN IF NOT EXISTS quote_text TEXT;
ALTER TABLE claim_page_references ADD COLUMN IF NOT EXISTS reference_id VARCHAR;

-- Create unique index on reference_id (only for non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpr_reference_id ON claim_page_references (reference_id) WHERE reference_id IS NOT NULL;

-- Create page_citations table
CREATE TABLE IF NOT EXISTS page_citations (
  id BIGSERIAL PRIMARY KEY,
  reference_id VARCHAR NOT NULL UNIQUE,
  page_id VARCHAR NOT NULL REFERENCES wiki_pages(id),
  title VARCHAR,
  url VARCHAR,
  note TEXT,
  resource_id VARCHAR REFERENCES resources(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pc_page_id ON page_citations (page_id);
CREATE INDEX IF NOT EXISTS idx_pc_reference_id ON page_citations (reference_id);

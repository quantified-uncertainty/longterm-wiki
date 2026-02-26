-- Migration 0031: Unify claims and citation_quotes
--
-- Adds verdict columns to claims and claim_sources tables,
-- creates claim_page_references join table linking claims to wiki pages,
-- and adds claim_id FK on citation_quotes for backward-compatible bridging.

-- 1. Verdict columns on claims
ALTER TABLE claims
  ADD COLUMN claim_verdict text,
  ADD COLUMN claim_verdict_score real,
  ADD COLUMN claim_verdict_issues text,
  ADD COLUMN claim_verdict_quotes text,
  ADD COLUMN claim_verdict_difficulty text,
  ADD COLUMN claim_verified_at timestamptz,
  ADD COLUMN claim_verdict_model text;

CREATE INDEX idx_cl_verdict ON claims (claim_verdict);
CREATE INDEX idx_cl_verified_at ON claims (claim_verified_at);

-- 2. Verdict columns on claim_sources
ALTER TABLE claim_sources
  ADD COLUMN source_verdict text,
  ADD COLUMN source_verdict_score real,
  ADD COLUMN source_verdict_issues text,
  ADD COLUMN source_checked_at timestamptz;

CREATE INDEX idx_cs_source_verdict ON claim_sources (source_verdict);

-- 3. claim_id FK on citation_quotes (nullable, bridges to claims)
ALTER TABLE citation_quotes
  ADD COLUMN claim_id bigint REFERENCES claims(id) ON DELETE SET NULL;

CREATE INDEX idx_cq_claim_id ON citation_quotes (claim_id);

-- 4. claim_page_references table
CREATE TABLE claim_page_references (
  id bigserial PRIMARY KEY,
  claim_id bigint NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  footnote integer,
  section text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_cpr_claim_id ON claim_page_references (claim_id);
CREATE INDEX idx_cpr_page_id ON claim_page_references (page_id);
CREATE UNIQUE INDEX idx_cpr_claim_page_footnote ON claim_page_references (claim_id, page_id, COALESCE(footnote, -1));

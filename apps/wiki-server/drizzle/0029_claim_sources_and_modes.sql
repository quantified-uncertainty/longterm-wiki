-- Phase 2: claim_sources join table, claim_mode, attributed_to, as_of, measure, numeric values
--
-- This migration adds:
--   1. claim_sources join table — proper relational multi-source provenance
--      (replaces the JSONB resource_ids array with per-row source quotes and is_primary flag)
--   2. claim_mode — epistemic mode: "endorsed" (wiki asserts) vs "attributed" (entity X claims)
--   3. attributed_to — entity_id of person/org making the claim (when claim_mode = attributed)
--   4. as_of — temporal indexing for time-sensitive claims
--   5. measure — links numeric claims to the facts taxonomy (e.g., "valuation", "employee_count")
--   6. value_numeric / value_low / value_high — machine-readable quantitative values
--      (enables trend queries, range display, and fact-claim reconciliation)

-- Add new columns to claims table
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_mode text;         -- 'endorsed' | 'attributed'
ALTER TABLE claims ADD COLUMN IF NOT EXISTS attributed_to text;      -- entity_id of claim author
ALTER TABLE claims ADD COLUMN IF NOT EXISTS as_of text;              -- YYYY-MM or YYYY-MM-DD
ALTER TABLE claims ADD COLUMN IF NOT EXISTS measure text;            -- measure ID (links to facts taxonomy)
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value_numeric real;      -- central numeric value
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value_low real;          -- lower bound for range values
ALTER TABLE claims ADD COLUMN IF NOT EXISTS value_high real;         -- upper bound for range values

-- Default existing claims to 'endorsed' (wiki-authored page claims are endorsements)
UPDATE claims SET claim_mode = 'endorsed' WHERE claim_mode IS NULL;

-- Indexes for new columns
CREATE INDEX IF NOT EXISTS idx_cl_claim_mode ON claims (claim_mode);
CREATE INDEX IF NOT EXISTS idx_cl_attributed_to ON claims (attributed_to);
CREATE INDEX IF NOT EXISTS idx_cl_as_of ON claims (as_of);
CREATE INDEX IF NOT EXISTS idx_cl_measure ON claims (measure);

-- claim_sources join table
-- Stores the N sources backing each claim, with per-source quote and primary flag.
-- Replaces the JSONB resource_ids array approach.
CREATE TABLE IF NOT EXISTS claim_sources (
  id          bigserial PRIMARY KEY,
  claim_id    bigint    NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  resource_id text      REFERENCES resources(id) ON DELETE SET NULL,
  url         text,                          -- fallback if resource_id not known
  source_quote text,                         -- exact excerpt from this source supporting the claim
  is_primary  boolean   NOT NULL DEFAULT false,
  added_at    timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cs_claim_id    ON claim_sources (claim_id);
CREATE INDEX IF NOT EXISTS idx_cs_resource_id ON claim_sources (resource_id);
CREATE INDEX IF NOT EXISTS idx_cs_is_primary  ON claim_sources (is_primary);

-- Migrate existing data: convert resource_ids JSONB array → claim_sources rows
-- Each resource_id becomes a claim_sources row with is_primary=true for the first one.
INSERT INTO claim_sources (claim_id, resource_id, is_primary)
SELECT
  c.id,
  r_id.resource_id,
  (r_id.idx = 0) AS is_primary
FROM claims c,
     jsonb_array_elements_text(c.resource_ids) WITH ORDINALITY AS r_id(resource_id, idx)
WHERE c.resource_ids IS NOT NULL
  AND jsonb_array_length(c.resource_ids) > 0
  -- Only insert if the resource actually exists
  AND EXISTS (SELECT 1 FROM resources r WHERE r.id = r_id.resource_id)
ON CONFLICT DO NOTHING;

-- Migrate existing sourceQuote from citation_quotes to claim_sources
-- Match claims to citation quotes via their footnoteRefs
-- (Best-effort: for claims with exactly one footnote ref, link the quote)
INSERT INTO claim_sources (claim_id, resource_id, url, source_quote, is_primary)
SELECT
  c.id,
  cq.resource_id,
  cq.url,
  cq.source_quote,
  true
FROM claims c
JOIN citation_quotes cq
  ON cq.page_id = c.entity_id
  AND cq.footnote::text = trim(c.footnote_refs)  -- single footnote ref
WHERE c.source_quote IS NULL
  AND c.footnote_refs IS NOT NULL
  AND c.footnote_refs NOT LIKE '%,%'             -- only single-footnote claims
  AND cq.source_quote IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM claim_sources cs WHERE cs.claim_id = c.id
  )
ON CONFLICT DO NOTHING;

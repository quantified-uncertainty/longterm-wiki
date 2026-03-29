-- Add unique constraint on claim_record_links to prevent duplicate associations.
-- The ON CONFLICT DO NOTHING in validate-claims.ts linkClaimsToRecords() needs this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crl_claim_record
  ON claim_record_links(claim_id, record_type, record_id);

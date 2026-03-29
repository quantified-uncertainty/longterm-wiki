-- Add unique constraint on claim_record_links to prevent duplicate associations.
-- The ON CONFLICT DO NOTHING in validate-claims.ts linkClaimsToRecords() needs this.

-- Dynamic dedup: remove any existing duplicates before creating the unique index.
-- Uses ROW_NUMBER() per database-migrations.md convention — handles ALL duplicates,
-- not just hardcoded IDs.
DELETE FROM claim_record_links
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY claim_id, record_type, record_id
      ORDER BY created_at, id  -- keep earliest; id as tiebreaker
    ) AS rn
    FROM claim_record_links
  ) ranked WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_crl_claim_record
  ON claim_record_links(claim_id, record_type, record_id);

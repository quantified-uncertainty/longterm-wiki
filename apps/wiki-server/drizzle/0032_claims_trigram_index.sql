-- GIN trigram index on claims.claim_text for efficient similarity() queries.
-- The pg_trgm extension was already enabled in migration 0025.
CREATE INDEX IF NOT EXISTS "idx_cl_claim_text_trgm"
  ON "claims" USING gin ("claim_text" gin_trgm_ops);

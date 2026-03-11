-- Fix grants.amount type: DOUBLE PRECISION → NUMERIC for precise financial amounts
ALTER TABLE grants ALTER COLUMN amount TYPE NUMERIC USING amount::NUMERIC;

-- Add grantee_id for forward compatibility (nullable — many grants don't specify a recipient entity)
ALTER TABLE grants ADD COLUMN IF NOT EXISTS grantee_id TEXT;
CREATE INDEX IF NOT EXISTS idx_grants_grantee ON grants(grantee_id);

-- Remove the redundant source_resource_id FK columns from 5 tables.
-- The source_check_evidence table (record_sources in future naming) already
-- links records to resources with richer metadata (verdict, confidence,
-- extracted quotes). Maintaining both creates drift risk.
-- See discussion #3993 and issue #4001.

DROP INDEX IF EXISTS idx_personnel_source_resource;
DROP INDEX IF EXISTS idx_grants_source_resource;
DROP INDEX IF EXISTS idx_funding_rounds_source_resource;
DROP INDEX IF EXISTS idx_investments_source_resource;
DROP INDEX IF EXISTS idx_equity_positions_source_resource;

ALTER TABLE personnel DROP COLUMN IF EXISTS source_resource_id;
ALTER TABLE grants DROP COLUMN IF EXISTS source_resource_id;
ALTER TABLE funding_rounds DROP COLUMN IF EXISTS source_resource_id;
ALTER TABLE investments DROP COLUMN IF EXISTS source_resource_id;
ALTER TABLE equity_positions DROP COLUMN IF EXISTS source_resource_id;

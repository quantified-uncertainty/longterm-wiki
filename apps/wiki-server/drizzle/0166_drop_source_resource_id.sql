-- Drop source_resource_id columns from 5 tables.
-- These FK columns are redundant with source_check_evidence.resourceId
-- which already links records to resources via the sourcing pipeline.
-- See Discussion #3993 for the full sourcing rename plan.

ALTER TABLE "personnel" DROP COLUMN IF EXISTS "source_resource_id";
ALTER TABLE "grants" DROP COLUMN IF EXISTS "source_resource_id";
ALTER TABLE "funding_rounds" DROP COLUMN IF EXISTS "source_resource_id";
ALTER TABLE "investments" DROP COLUMN IF EXISTS "source_resource_id";
ALTER TABLE "equity_positions" DROP COLUMN IF EXISTS "source_resource_id";

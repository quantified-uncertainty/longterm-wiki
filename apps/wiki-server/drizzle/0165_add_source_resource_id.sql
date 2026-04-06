-- Add source_resource_id FK to tables with plain-text source URL columns.
-- This enables linking record sources to the resources table for rich metadata,
-- verification, and dead-link tracking. The existing source text column is kept
-- for backward compatibility during transition.
ALTER TABLE personnel
  ADD COLUMN IF NOT EXISTS source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

ALTER TABLE funding_rounds
  ADD COLUMN IF NOT EXISTS source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

ALTER TABLE equity_positions
  ADD COLUMN IF NOT EXISTS source_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_personnel_source_resource ON personnel (source_resource_id);
CREATE INDEX IF NOT EXISTS idx_grants_source_resource ON grants (source_resource_id);
CREATE INDEX IF NOT EXISTS idx_funding_rounds_source_resource ON funding_rounds (source_resource_id);
CREATE INDEX IF NOT EXISTS idx_investments_source_resource ON investments (source_resource_id);
CREATE INDEX IF NOT EXISTS idx_equity_positions_source_resource ON equity_positions (source_resource_id);

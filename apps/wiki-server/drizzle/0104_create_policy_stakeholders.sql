-- Policy stakeholders: entity positions on policy/legislation entities.
-- Enables cross-entity queries like "which orgs oppose AI regulation?"

CREATE TABLE IF NOT EXISTS policy_stakeholders (
  id VARCHAR(10) PRIMARY KEY,
  policy_entity_id TEXT NOT NULL REFERENCES entities(stable_id) ON DELETE CASCADE,
  stakeholder_entity_id TEXT REFERENCES entities(stable_id) ON DELETE SET NULL,
  stakeholder_display_name TEXT NOT NULL,
  position TEXT NOT NULL,  -- support | oppose | neutral | mixed
  reason TEXT,
  source TEXT,
  context JSONB,  -- array of contextual notes
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_policy ON policy_stakeholders(policy_entity_id);
CREATE INDEX IF NOT EXISTS idx_ps_stakeholder ON policy_stakeholders(stakeholder_entity_id);
CREATE INDEX IF NOT EXISTS idx_ps_position ON policy_stakeholders(position);

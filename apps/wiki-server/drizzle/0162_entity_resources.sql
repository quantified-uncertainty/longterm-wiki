-- Entity Resources — join table linking entities to resources with relationship metadata.
-- Replaces heuristic domain-matching in org-data.ts with proper relational data.
CREATE TABLE IF NOT EXISTS entity_resources (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(stable_id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  authored_by_entity BOOLEAN NOT NULL DEFAULT FALSE,
  is_subject BOOLEAN NOT NULL DEFAULT FALSE,
  inference_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_er_entity_resource
  ON entity_resources (entity_id, resource_id);

CREATE INDEX IF NOT EXISTS idx_er_entity
  ON entity_resources (entity_id);

CREATE INDEX IF NOT EXISTS idx_er_resource
  ON entity_resources (resource_id);

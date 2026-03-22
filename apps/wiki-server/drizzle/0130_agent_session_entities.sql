-- Track which entities (by stableId) each agent session touched.
-- Mirrors agent_session_pages but for entities instead of pages.
CREATE TABLE IF NOT EXISTS agent_session_entities (
  agent_session_id BIGINT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  entity_stable_id TEXT NOT NULL,
  PRIMARY KEY (agent_session_id, entity_stable_id)
);

CREATE INDEX IF NOT EXISTS idx_ase_entity_stable_id ON agent_session_entities(entity_stable_id);
CREATE INDEX IF NOT EXISTS idx_ase_agent_session_id ON agent_session_entities(agent_session_id);

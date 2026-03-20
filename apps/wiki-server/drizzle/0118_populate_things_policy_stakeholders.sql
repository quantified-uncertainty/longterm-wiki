-- Populate the things table from existing policy_stakeholders rows.
-- Idempotent: uses ON CONFLICT DO NOTHING so it can be re-run safely.
-- The dual-write in the sync handler keeps future rows in sync.

INSERT INTO things (
  id, thing_type, title, parent_thing_id, source_table, source_id,
  parent_title, source_url, created_at, updated_at, synced_at
)
SELECT
  ps.id,
  'policy-stakeholder',
  ps.stakeholder_display_name || ' on ' || COALESCE(e.title, ps.policy_entity_id),
  -- Link to parent policy entity thing (look up by stableId)
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = e.id LIMIT 1),
  'policy_stakeholders',
  ps.id,
  COALESCE(e.title, ps.policy_entity_id),
  ps.source,
  ps.created_at,
  ps.updated_at,
  NOW()
FROM policy_stakeholders ps
LEFT JOIN entities e ON e.stable_id = ps.policy_entity_id
ON CONFLICT (source_table, source_id) DO NOTHING;

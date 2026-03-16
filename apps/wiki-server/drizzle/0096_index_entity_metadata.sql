-- Expression indexes on entities.metadata JSONB for directory page queries.
-- These are partial indexes filtered by entity_type, so they stay small and
-- only accelerate queries that already filter on the correct type.
--
-- The entities table has ~1,000 rows, so these complete instantly and do not
-- need the manual-migration pattern.

CREATE INDEX IF NOT EXISTS idx_ent_meta_org_type
  ON entities ((metadata->>'orgType'))
  WHERE entity_type = 'organization';

CREATE INDEX IF NOT EXISTS idx_ent_meta_developer
  ON entities ((metadata->>'developer'))
  WHERE entity_type = 'ai-model';

CREATE INDEX IF NOT EXISTS idx_ent_meta_risk_category
  ON entities ((metadata->>'riskCategory'))
  WHERE entity_type = 'risk';

CREATE INDEX IF NOT EXISTS idx_ent_meta_project_status
  ON entities ((metadata->>'projectStatus'))
  WHERE entity_type = 'project';

CREATE INDEX IF NOT EXISTS idx_ent_meta_policy_status
  ON entities ((metadata->>'policyStatus'))
  WHERE entity_type = 'policy';

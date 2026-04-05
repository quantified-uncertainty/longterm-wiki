-- Resource Tabular Sources — sub-table for structured data import sources.
-- Follows the resourcePapers/resourceForumPosts/resourcePolicyDocs pattern.
--
-- Also adds:
-- - resource_id column to source_snapshots (transition FK)
-- - data_source_resource_id column to grants (transition FK)
--
-- Data migration is in a separate manual script:
--   apps/wiki-server/scripts/0160_migrate_tabular_sources.sql

-- 1. Create the resource_tabular_sources sub-table
CREATE TABLE IF NOT EXISTS resource_tabular_sources (
  resource_id       text PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  source_slug       text NOT NULL UNIQUE,
  data_format       text NOT NULL,
  access_method     text NOT NULL,
  record_type       text NOT NULL,
  update_frequency  text,
  column_mapping    jsonb,
  source_schema     jsonb,
  verification_config jsonb,
  source_status     text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rts_record_type
  ON resource_tabular_sources (record_type);
CREATE INDEX IF NOT EXISTS idx_rts_source_status
  ON resource_tabular_sources (source_status);

-- 2. Add resource_id to source_snapshots (nullable during transition)
ALTER TABLE source_snapshots
  ADD COLUMN IF NOT EXISTS resource_id text REFERENCES resources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ss_resource_id
  ON source_snapshots (resource_id);

-- 3. Add data_source_resource_id to grants (nullable during transition)
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS data_source_resource_id text REFERENCES resources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_grants_data_source_resource
  ON grants (data_source_resource_id);

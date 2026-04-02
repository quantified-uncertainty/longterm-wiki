-- Phase 1: Data Source Resources — schema foundation
-- Discussion #3567: Data Source Resources: Structured Data Verification System
--
-- data_sources: Standalone table (not a resource sub-table) describing structured
-- data sources like grant CSVs, APIs, and HTML tables. Identified by source_id
-- (e.g., "coefficient-giving"), not by URL.
--
-- source_snapshots: Permanent storage of raw source content (CSV text, HTML, JSON).
-- Content-hash dedup prevents storing identical snapshots. Kept forever for provenance.

CREATE TABLE IF NOT EXISTS data_sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  data_format text NOT NULL,
  access_method text NOT NULL,
  record_type text NOT NULL,
  fetch_url text,
  resource_id text REFERENCES resources(id) ON DELETE SET NULL,
  publisher_entity_id text,
  update_frequency text,
  column_mapping jsonb,
  source_schema jsonb,
  verification_config jsonb,
  last_snapshot_at timestamptz,
  snapshot_record_count integer,
  latest_snapshot_hash text,
  source_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ds_record_type ON data_sources (record_type);
CREATE INDEX IF NOT EXISTS idx_ds_publisher ON data_sources (publisher_entity_id);
CREATE INDEX IF NOT EXISTS idx_ds_source_status ON data_sources (source_status);

CREATE TABLE IF NOT EXISTS source_snapshots (
  id bigserial PRIMARY KEY,
  data_source_id text NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  snapshot_hash text NOT NULL,
  record_count integer,
  raw_content text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  mapping_valid boolean NOT NULL DEFAULT true,
  parser_version text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_dedup ON source_snapshots (data_source_id, snapshot_hash);
CREATE INDEX IF NOT EXISTS idx_ss_data_source ON source_snapshots (data_source_id);
CREATE INDEX IF NOT EXISTS idx_ss_fetched_at ON source_snapshots (fetched_at);

-- Migrate data_sources → resources + resource_tabular_sources.
--
-- Run AFTER migration 0160 creates the tables:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/0160_migrate_tabular_sources.sql
--
-- Idempotent: uses ON CONFLICT DO NOTHING / IF NOT EXISTS throughout.
-- Only ~16 rows — completes in under 1s.
--
-- Steps:
-- 1. Enable pgcrypto (needed for hashId computation)
-- 2. Create resource rows from data_sources
-- 3. Create resource_tabular_sources rows
-- 4. Backfill source_snapshots.resource_id
-- 5. Backfill grants.data_source_resource_id

-- 1. Enable pgcrypto for SHA-256 hash computation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Helper: replicate the Node hashId() function (SHA-256, first 16 hex chars)
-- hashId(url) = createHash('sha256').update(url).digest('hex').slice(0, 16)
CREATE OR REPLACE FUNCTION pg_temp.hash_id(input text) RETURNS text AS $$
  SELECT left(encode(digest(input, 'sha256'), 'hex'), 16);
$$ LANGUAGE sql IMMUTABLE;

-- 2. Create resource rows from data_sources.
-- URL is fetch_url if present, otherwise a synthetic URN.
INSERT INTO resources (id, url, title, type, resource_subtype, publisher_entity_id, created_at, updated_at)
SELECT
  pg_temp.hash_id(COALESCE(ds.fetch_url, 'urn:lw:tabular-source:' || ds.id)),
  COALESCE(ds.fetch_url, 'urn:lw:tabular-source:' || ds.id),
  ds.name,
  'dataset',
  'tabular_source',
  ds.publisher_entity_id,
  ds.created_at,
  ds.updated_at
FROM data_sources ds
ON CONFLICT (id) DO NOTHING;

-- 3. Create resource_tabular_sources rows.
INSERT INTO resource_tabular_sources (
  resource_id, source_slug, data_format, access_method, record_type,
  update_frequency, column_mapping, source_schema, verification_config,
  source_status, created_at, updated_at
)
SELECT
  pg_temp.hash_id(COALESCE(ds.fetch_url, 'urn:lw:tabular-source:' || ds.id)),
  ds.id,  -- source_slug = old data_sources.id
  ds.data_format,
  ds.access_method,
  ds.record_type,
  ds.update_frequency,
  ds.column_mapping,
  ds.source_schema,
  ds.verification_config,
  ds.source_status,
  ds.created_at,
  ds.updated_at
FROM data_sources ds
ON CONFLICT (resource_id) DO NOTHING;

-- 4. Backfill source_snapshots.resource_id from the mapping.
UPDATE source_snapshots ss
SET resource_id = rts.resource_id
FROM resource_tabular_sources rts
WHERE rts.source_slug = ss.data_source_id
  AND ss.resource_id IS NULL;

-- 5. Backfill grants.data_source_resource_id from the mapping.
UPDATE grants g
SET data_source_resource_id = rts.resource_id
FROM resource_tabular_sources rts
WHERE rts.source_slug = g.data_source_id
  AND g.data_source_resource_id IS NULL;

-- Verify
DO $$
DECLARE
  ds_count integer;
  rts_count integer;
  ss_filled integer;
  grants_filled integer;
BEGIN
  SELECT count(*) INTO ds_count FROM data_sources;
  SELECT count(*) INTO rts_count FROM resource_tabular_sources;
  SELECT count(*) INTO ss_filled FROM source_snapshots WHERE resource_id IS NOT NULL;
  SELECT count(*) INTO grants_filled FROM grants WHERE data_source_resource_id IS NOT NULL;

  RAISE NOTICE 'Data sources: %, Tabular sources created: %, Snapshots linked: %, Grants linked: %',
    ds_count, rts_count, ss_filled, grants_filled;
END $$;

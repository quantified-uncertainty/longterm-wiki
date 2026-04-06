-- Drop the legacy data_sources table.
--
-- Reads/writes already use resources + resource_tabular_sources (PR #3915/3916).
-- source_snapshots.data_source_id values are identical to
-- resource_tabular_sources.source_slug, so the FK simply re-targets.
--
-- Steps:
--   1. Add source_slug column to source_snapshots (nullable initially)
--   2. Backfill source_slug from data_source_id (identical values)
--   3. Drop old FK + dedup index referencing data_sources
--   4. Recreate dedup index using source_slug
--   5. Add NOT NULL + FK constraint for source_slug
--   6. Drop data_source_id column from source_snapshots
--   7. Drop data_source_resource_id column from grants (transition FK, never populated)
--   8. Drop the data_sources table

-- 1. Add source_slug column
ALTER TABLE source_snapshots
  ADD COLUMN IF NOT EXISTS source_slug text;

-- 2. Backfill from data_source_id (same values — they're both the human-readable slug)
UPDATE source_snapshots SET source_slug = data_source_id WHERE source_slug IS NULL;

-- 3. Drop old constraints that reference data_source_id / data_sources
--    idx_ss_dedup is UNIQUE(data_source_id, snapshot_hash) — must be dropped before column removal
DROP INDEX IF EXISTS idx_ss_dedup;
DROP INDEX IF EXISTS idx_ss_data_source;

-- 4. Recreate the dedup index on (source_slug, snapshot_hash)
CREATE UNIQUE INDEX idx_ss_dedup ON source_snapshots (source_slug, snapshot_hash);
CREATE INDEX idx_ss_source_slug ON source_snapshots (source_slug);

-- 5. Make source_slug NOT NULL + add FK to resource_tabular_sources
ALTER TABLE source_snapshots ALTER COLUMN source_slug SET NOT NULL;
ALTER TABLE source_snapshots
  ADD CONSTRAINT fk_ss_source_slug
  FOREIGN KEY (source_slug) REFERENCES resource_tabular_sources(source_slug) ON DELETE CASCADE;

-- 6. Drop the old data_source_id column (FK to data_sources is implicitly dropped)
ALTER TABLE source_snapshots DROP COLUMN IF EXISTS data_source_id;

-- 7. Drop the transition FK column on grants (was added in 0160, never populated with data)
ALTER TABLE grants DROP COLUMN IF EXISTS data_source_resource_id;

-- 8. Re-point grants.data_source_id FK from data_sources → resource_tabular_sources
--    Values are identical slugs (e.g., "coefficient-giving")
ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_data_source_id_data_sources_id_fk;
ALTER TABLE grants
  ADD CONSTRAINT grants_data_source_id_rts_source_slug_fk
  FOREIGN KEY (data_source_id) REFERENCES resource_tabular_sources(source_slug) ON DELETE SET NULL;

-- 9. Finally, drop the data_sources table itself
DROP TABLE IF EXISTS data_sources;

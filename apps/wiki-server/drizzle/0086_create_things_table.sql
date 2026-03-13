-- Create the unified things table.
-- Every identifiable item in the system (entity, fact, grant, resource,
-- personnel record, division, benchmark, etc.) gets a single row here,
-- enabling cross-domain queries, unified verification, and a single browse UI.

CREATE TABLE IF NOT EXISTS things (
  id TEXT PRIMARY KEY,                        -- stableId (10-char) or composite key
  thing_type TEXT NOT NULL,                   -- 'entity' | 'fact' | 'grant' | 'resource' | 'personnel' | 'division' | 'funding-round' | 'investment' | 'equity-position' | 'benchmark' | 'benchmark-result' | 'funding-program' | 'division-personnel'
  title TEXT NOT NULL,                        -- human-readable display name
  parent_thing_id TEXT REFERENCES things(id) ON DELETE SET NULL,  -- hierarchical parent (e.g., grant → org, personnel → org)
  source_table TEXT NOT NULL,                 -- origin table name for traceability
  source_id TEXT NOT NULL,                    -- PK in the source table
  entity_type TEXT,                           -- entity_type for entities, null for others
  description TEXT,
  source_url TEXT,                            -- link to primary source
  numeric_id TEXT,                            -- E-prefixed numeric ID (entities only)
  verdict TEXT,                               -- latest aggregate verdict (denormalized from record_verdicts/kb_fact_verdicts)
  verdict_confidence REAL,                    -- latest verdict confidence
  verdict_at TIMESTAMPTZ,                     -- when verdict was last computed
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_things_type ON things(thing_type);
CREATE INDEX IF NOT EXISTS idx_things_parent ON things(parent_thing_id);
CREATE INDEX IF NOT EXISTS idx_things_source ON things(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_things_entity_type ON things(entity_type);
CREATE INDEX IF NOT EXISTS idx_things_verdict ON things(verdict);
CREATE INDEX IF NOT EXISTS idx_things_updated ON things(updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_things_source_unique ON things(source_table, source_id);

-- Full-text search on title and description
ALTER TABLE things ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS idx_things_search ON things USING GIN(search_vector);

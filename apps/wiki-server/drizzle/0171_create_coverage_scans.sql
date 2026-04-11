CREATE TABLE IF NOT EXISTS tablebase_coverage_scans (
  id             SERIAL PRIMARY KEY,
  entity_type    TEXT    NOT NULL,
  entity_id      TEXT    NOT NULL,
  coverage_score INTEGER NOT NULL CHECK (coverage_score BETWEEN 1 AND 4),
  signals_filled INTEGER NOT NULL DEFAULT 0,
  signals_total  INTEGER NOT NULL DEFAULT 0,
  signals        JSONB   NOT NULL DEFAULT '{}',
  scanned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coverage_scans_entity ON tablebase_coverage_scans (entity_id);
CREATE INDEX IF NOT EXISTS idx_coverage_scans_type_score ON tablebase_coverage_scans (entity_type, coverage_score);
CREATE INDEX IF NOT EXISTS idx_coverage_scans_scanned_at ON tablebase_coverage_scans (scanned_at);

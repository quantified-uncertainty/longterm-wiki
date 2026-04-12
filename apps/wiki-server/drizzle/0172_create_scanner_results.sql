-- Persist TableBase scanner results (per-entity, per-table completeness data).
-- Different from tablebase_coverage_scans (entity-level 1-4 scores) — this stores
-- the raw scanner output: record counts, completeness percentages, missing fields,
-- grouped by scan_run_id for trend analysis.

CREATE TABLE IF NOT EXISTS tablebase_scanner_results (
  id             BIGSERIAL PRIMARY KEY,
  scan_run_id    TEXT         NOT NULL,
  record_type    TEXT         NOT NULL,
  entity_id      TEXT         NOT NULL,
  entity_name    TEXT         NOT NULL,
  entity_type    TEXT         NOT NULL,
  total_records  INTEGER      NOT NULL DEFAULT 0,
  verified_records INTEGER    NOT NULL DEFAULT 0,
  completeness_pct REAL       NOT NULL DEFAULT 0,
  missing_fields JSONB        NOT NULL DEFAULT '[]',
  entity_importance REAL,
  scanned_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scanner_results_run_id ON tablebase_scanner_results (scan_run_id);
CREATE INDEX IF NOT EXISTS idx_scanner_results_entity ON tablebase_scanner_results (entity_id);
CREATE INDEX IF NOT EXISTS idx_scanner_results_scanned_at ON tablebase_scanner_results (scanned_at);
CREATE INDEX IF NOT EXISTS idx_scanner_results_type_entity ON tablebase_scanner_results (record_type, entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_results_natural_key ON tablebase_scanner_results (scan_run_id, record_type, entity_id);

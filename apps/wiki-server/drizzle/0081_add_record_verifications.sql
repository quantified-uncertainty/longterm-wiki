-- Record verification tables for structured data (grants, personnel, etc.)
-- Mirrors the KB fact verification two-tier model: evidence → verdicts.

CREATE TABLE IF NOT EXISTS record_verifications (
  id BIGSERIAL PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_id VARCHAR(10) NOT NULL,
  field_name TEXT,
  expected_value TEXT,
  source_url TEXT,
  verdict TEXT NOT NULL,
  confidence REAL,
  extracted_value TEXT,
  checker_model TEXT,
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rv_record ON record_verifications (record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_rv_verdict ON record_verifications (verdict);
CREATE INDEX IF NOT EXISTS idx_rv_type ON record_verifications (record_type);

CREATE TABLE IF NOT EXISTS record_verdicts (
  record_type TEXT NOT NULL,
  record_id VARCHAR(10) NOT NULL,
  verdict TEXT NOT NULL,
  confidence REAL,
  reasoning TEXT,
  sources_checked INTEGER NOT NULL DEFAULT 0,
  needs_recheck BOOLEAN NOT NULL DEFAULT FALSE,
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (record_type, record_id)
);

CREATE INDEX IF NOT EXISTS idx_rvd_verdict ON record_verdicts (verdict);
CREATE INDEX IF NOT EXISTS idx_rvd_recheck ON record_verdicts (needs_recheck);
CREATE INDEX IF NOT EXISTS idx_rvd_type ON record_verdicts (record_type);

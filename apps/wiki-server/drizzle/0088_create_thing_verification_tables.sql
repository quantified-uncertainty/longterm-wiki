-- Thing-level verification tables (evidence + aggregate pattern)
-- Mirrors record_verifications / record_verdicts but keyed by things.id

-- ── Evidence tier: per-source verification checks ──

CREATE TABLE IF NOT EXISTS thing_resource_verifications (
  id BIGSERIAL PRIMARY KEY,
  thing_id TEXT NOT NULL REFERENCES things(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resources(id),
  source_url TEXT,
  field_name TEXT,
  expected_value TEXT,
  verdict TEXT NOT NULL,
  confidence REAL,
  extracted_value TEXT,
  checker_model TEXT,
  is_primary_source BOOLEAN DEFAULT false,
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trv_thing ON thing_resource_verifications(thing_id);
CREATE INDEX IF NOT EXISTS idx_trv_verdict ON thing_resource_verifications(verdict);

-- ── Aggregate tier: one verdict per thing ──

CREATE TABLE IF NOT EXISTS thing_verdicts (
  thing_id TEXT PRIMARY KEY REFERENCES things(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  confidence REAL,
  reasoning TEXT,
  sources_checked INTEGER DEFAULT 0,
  needs_recheck BOOLEAN NOT NULL DEFAULT false,
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tvd_verdict ON thing_verdicts(verdict);
CREATE INDEX IF NOT EXISTS idx_tvd_recheck ON thing_verdicts(needs_recheck);

-- ── Backfill from record_verifications / record_verdicts ──
-- Join via things source mapping to migrate existing verification data.

INSERT INTO thing_resource_verifications (thing_id, source_url, field_name, expected_value, verdict, confidence, extracted_value, checker_model, notes, checked_at, created_at, updated_at)
SELECT t.id, rv.source_url, rv.field_name, rv.expected_value, rv.verdict, rv.confidence, rv.extracted_value, rv.checker_model, rv.notes, rv.checked_at, rv.created_at, rv.updated_at
FROM record_verifications rv
JOIN things t ON t.source_table = rv.record_type AND t.source_id = rv.record_id
ON CONFLICT DO NOTHING;

INSERT INTO thing_verdicts (thing_id, verdict, confidence, reasoning, sources_checked, needs_recheck, last_computed_at, created_at, updated_at)
SELECT t.id, rvd.verdict, rvd.confidence, rvd.reasoning, rvd.sources_checked, rvd.needs_recheck, rvd.last_computed_at, rvd.created_at, rvd.updated_at
FROM record_verdicts rvd
JOIN things t ON t.source_table = rvd.record_type AND t.source_id = rvd.record_id
ON CONFLICT (thing_id) DO NOTHING;

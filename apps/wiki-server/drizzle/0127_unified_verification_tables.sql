-- Unified verification system: 2 tables replace 6
-- See discussion #2950 for architecture decisions.
--
-- Replaces:
--   kb_fact_resource_verifications + kb_fact_verdicts       (FactBase)
--   record_verifications          + record_verdicts         (TableBase records)
--   thing_resource_verifications   + thing_verdicts          (Things)
-- Also removes denormalized verdict columns from the things table.

-- ── Step 1: Create new unified tables ────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_evidence (
  id BIGSERIAL PRIMARY KEY,
  record_type TEXT NOT NULL,             -- 'fact', 'grant', 'personnel', 'investment', etc.
  record_id TEXT NOT NULL,               -- PK in the source table
  field_name TEXT,                       -- NULL = whole row, or 'amount', 'revenue', etc.
  entity_id TEXT,                        -- which entity this is about (for grouping/display)
  expected_value TEXT,                   -- what the record says
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  source_url TEXT,                       -- direct URL
  extracted_value TEXT,                  -- what the source says
  extracted_quote TEXT,                  -- relevant passage from source
  verdict TEXT NOT NULL,                 -- confirmed | contradicted | unverifiable | outdated | partial
  confidence REAL,                       -- 0.0 to 1.0
  is_primary_source BOOLEAN NOT NULL DEFAULT false,
  checker_model TEXT,
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ve_record ON verification_evidence (record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_ve_entity ON verification_evidence (entity_id);
CREATE INDEX IF NOT EXISTS idx_ve_verdict ON verification_evidence (verdict);
CREATE INDEX IF NOT EXISTS idx_ve_checked ON verification_evidence (checked_at);

CREATE TABLE IF NOT EXISTS verification_verdicts (
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_name TEXT,                       -- NULL = whole row verdict
  entity_id TEXT,                        -- for grouping/display
  verdict TEXT NOT NULL,                 -- confirmed | contradicted | outdated | partial | unverifiable | unchecked
  confidence REAL,
  reasoning TEXT,
  sources_checked INT NOT NULL DEFAULT 0,
  needs_recheck BOOLEAN NOT NULL DEFAULT false,
  next_check_due TIMESTAMPTZ,            -- for auto-recheck scheduling
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Expression-based unique constraint (PG doesn't support COALESCE in PRIMARY KEY)
CREATE UNIQUE INDEX IF NOT EXISTS idx_vv_pk ON verification_verdicts (record_type, record_id, COALESCE(field_name, ''));

CREATE INDEX IF NOT EXISTS idx_vv_verdict ON verification_verdicts (verdict);
CREATE INDEX IF NOT EXISTS idx_vv_recheck ON verification_verdicts (needs_recheck);
CREATE INDEX IF NOT EXISTS idx_vv_entity ON verification_verdicts (entity_id);
CREATE INDEX IF NOT EXISTS idx_vv_type ON verification_verdicts (record_type);

-- ── Step 2: Migrate existing data ────────────────────────────────────────

-- 2a. Migrate FactBase resource verifications → verification_evidence
INSERT INTO verification_evidence (
  record_type, record_id, field_name, entity_id, expected_value,
  resource_id, source_url, extracted_value, extracted_quote,
  verdict, confidence, is_primary_source, checker_model, notes,
  checked_at, created_at, updated_at
)
SELECT
  'fact',
  kfrv.fact_id,
  NULL,                          -- facts are already cell-level
  f.entity_id,                   -- join to get entity
  NULL,                          -- no expected_value in old schema
  kfrv.resource_id,
  kfrv.source_url,
  kfrv.extracted_value,
  NULL,                          -- no extracted_quote in old schema
  kfrv.verdict,
  kfrv.confidence,
  kfrv.is_primary_source,
  kfrv.checker_model,
  kfrv.notes,
  kfrv.checked_at,
  kfrv.created_at,
  kfrv.updated_at
FROM kb_fact_resource_verifications kfrv
LEFT JOIN facts f ON f.fact_id = kfrv.fact_id;

-- 2b. Migrate record verifications → verification_evidence
-- The thing_resource_verifications table was backfilled FROM record_verifications
-- in migration 0088, so we only need to migrate record_verifications (not thing_resource_verifications).
INSERT INTO verification_evidence (
  record_type, record_id, field_name, entity_id, expected_value,
  resource_id, source_url, extracted_value, extracted_quote,
  verdict, confidence, is_primary_source, checker_model, notes,
  checked_at, created_at, updated_at
)
SELECT
  rv.record_type,
  rv.record_id,
  rv.field_name,
  NULL,                          -- no entity_id in old schema
  rv.expected_value,
  NULL,                          -- no resource_id FK in old schema
  rv.source_url,
  rv.extracted_value,
  NULL,                          -- no extracted_quote in old schema
  rv.verdict,
  rv.confidence,
  false,                         -- no is_primary_source in old schema
  rv.checker_model,
  rv.notes,
  rv.checked_at,
  rv.created_at,
  rv.updated_at
FROM record_verifications rv;

-- 2c. Migrate FactBase verdicts → verification_verdicts
INSERT INTO verification_verdicts (
  record_type, record_id, field_name, entity_id,
  verdict, confidence, reasoning, sources_checked,
  needs_recheck, next_check_due, last_computed_at,
  created_at, updated_at
)
SELECT
  'fact',
  kfv.fact_id,
  NULL,
  f.entity_id,
  kfv.verdict,
  kfv.confidence,
  kfv.reasoning,
  kfv.sources_checked,
  kfv.needs_recheck,
  NULL,                          -- no next_check_due in old schema
  kfv.last_computed_at,
  kfv.created_at,
  kfv.updated_at
FROM kb_fact_verdicts kfv
LEFT JOIN facts f ON f.fact_id = kfv.fact_id
ON CONFLICT (record_type, record_id, COALESCE(field_name, '')) DO NOTHING;

-- 2d. Migrate record verdicts → verification_verdicts
INSERT INTO verification_verdicts (
  record_type, record_id, field_name, entity_id,
  verdict, confidence, reasoning, sources_checked,
  needs_recheck, next_check_due, last_computed_at,
  created_at, updated_at
)
SELECT
  rv.record_type,
  rv.record_id,
  NULL,
  NULL,
  rv.verdict,
  rv.confidence,
  rv.reasoning,
  rv.sources_checked,
  rv.needs_recheck,
  NULL,
  rv.last_computed_at,
  rv.created_at,
  rv.updated_at
FROM record_verdicts rv
ON CONFLICT (record_type, record_id, COALESCE(field_name, '')) DO NOTHING;

-- ── Step 3: Drop old tables ──────────────────────────────────────────────

-- Drop thing verification tables first (they have FK to things)
DROP TABLE IF EXISTS thing_resource_verifications CASCADE;
DROP TABLE IF EXISTS thing_verdicts CASCADE;

-- Drop FactBase verification tables
DROP TABLE IF EXISTS kb_fact_resource_verifications CASCADE;
DROP TABLE IF EXISTS kb_fact_verdicts CASCADE;

-- Drop record verification tables
DROP TABLE IF EXISTS record_verifications CASCADE;
DROP TABLE IF EXISTS record_verdicts CASCADE;

-- ── Step 4: Remove denormalized verdict columns from things ──────────────

DROP INDEX IF EXISTS idx_things_verdict;
ALTER TABLE things DROP COLUMN IF EXISTS verdict;
ALTER TABLE things DROP COLUMN IF EXISTS verdict_confidence;
ALTER TABLE things DROP COLUMN IF EXISTS verdict_at;

-- Per-resource verification evidence for KB facts.
-- Each row records one LLM check of a fact against a specific source.
-- A fact can have multiple verification rows (one per resource checked).

CREATE TABLE IF NOT EXISTS kb_fact_verifications (
  id SERIAL PRIMARY KEY,
  fact_id TEXT NOT NULL,           -- KB fact ID (e.g., f_i59sRXPSZw)
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial')),
  confidence REAL,                 -- 0.0 to 1.0
  extracted_value TEXT,            -- What the source actually says
  checker_model TEXT,              -- Which LLM checked this (e.g., claude-sonnet-4-6)
  content_hash TEXT,               -- SHA-256 prefix of source text at check time (staleness detection)
  is_primary_source BOOLEAN NOT NULL DEFAULT false, -- true if resource is the fact's own source URL
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_fact_verifications_fact_id ON kb_fact_verifications(fact_id);
CREATE INDEX IF NOT EXISTS idx_kb_fact_verifications_verdict ON kb_fact_verifications(verdict);

-- Aggregate per-fact verdict, derived from per-resource verifications.
-- One row per fact. Recomputed periodically from kb_fact_verifications.

CREATE TABLE IF NOT EXISTS kb_fact_verdicts (
  fact_id TEXT PRIMARY KEY,        -- KB fact ID (e.g., f_i59sRXPSZw)
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial', 'unchecked')),
  confidence REAL,                 -- 0.0 to 1.0, aggregate across sources
  reasoning TEXT,                  -- Why this overall verdict
  sources_checked INTEGER NOT NULL DEFAULT 0, -- How many resources were evaluated
  needs_recheck BOOLEAN NOT NULL DEFAULT false, -- Flagged if evidence is stale or conflicting
  last_computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_fact_verdicts_verdict ON kb_fact_verdicts(verdict);
CREATE INDEX IF NOT EXISTS idx_kb_fact_verdicts_needs_recheck ON kb_fact_verdicts(needs_recheck) WHERE needs_recheck = true;

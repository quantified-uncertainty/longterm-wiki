CREATE TABLE IF NOT EXISTS kb_fact_verifications (
  id SERIAL PRIMARY KEY,
  fact_id TEXT NOT NULL,           -- KB fact ID (e.g., f_i59sRXPSZw)
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial')),
  confidence REAL,                 -- 0.0 to 1.0
  extracted_value TEXT,            -- What the source actually says
  checker_model TEXT,              -- Which LLM checked this (e.g., claude-sonnet-4-6)
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_fact_verifications_fact_id ON kb_fact_verifications(fact_id);
CREATE INDEX IF NOT EXISTS idx_kb_fact_verifications_verdict ON kb_fact_verifications(verdict);

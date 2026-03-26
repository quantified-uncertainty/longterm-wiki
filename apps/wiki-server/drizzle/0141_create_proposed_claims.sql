-- Claims-first verification tables (issue #3253, Component 1)
-- Research agents propose structured claims; a worker verifies them before applying.

CREATE TABLE IF NOT EXISTS proposed_claims (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,

  -- What's being claimed
  claim_text TEXT NOT NULL,
  entity_id TEXT,
  target_table TEXT NOT NULL,
  target_field TEXT,
  proposed_value TEXT,
  proposed_data JSONB,

  -- Source evidence (from research agent)
  resource_id TEXT REFERENCES resources(id),
  source_url TEXT NOT NULL,
  agent_evidence TEXT,

  -- Verification state (updated by worker)
  status TEXT NOT NULL DEFAULT 'pending',
  verdict_confidence REAL,
  verdict_reasoning TEXT,
  extracted_value TEXT,
  checker_model TEXT,
  verified_at TIMESTAMPTZ,
  evidence_id BIGINT,

  -- Job tracking
  verification_job_id BIGINT,

  -- Audit
  submitted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claim_record_links (
  id BIGSERIAL PRIMARY KEY,
  claim_id BIGINT NOT NULL REFERENCES proposed_claims(id),
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  match_verdict TEXT,
  match_confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for proposed_claims
CREATE INDEX idx_pc_batch ON proposed_claims(batch_id);
CREATE INDEX idx_pc_status ON proposed_claims(status);
CREATE INDEX idx_pc_entity ON proposed_claims(entity_id);
CREATE INDEX idx_pc_resource ON proposed_claims(resource_id);
CREATE INDEX idx_pc_target ON proposed_claims(target_table, entity_id);

-- Indexes for claim_record_links
CREATE INDEX idx_crl_claim ON claim_record_links(claim_id);
CREATE INDEX idx_crl_record ON claim_record_links(record_type, record_id);

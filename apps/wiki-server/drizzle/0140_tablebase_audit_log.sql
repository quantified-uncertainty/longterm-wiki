CREATE TABLE IF NOT EXISTS tablebase_audit_log (
  id BIGSERIAL PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_id VARCHAR(10) NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'delete')),
  old_data JSONB,
  new_data JSONB NOT NULL,
  source_url TEXT,
  verdict TEXT,
  evidence TEXT,
  agent_session_id TEXT,
  pr_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_record ON tablebase_audit_log(record_type, record_id);
CREATE INDEX idx_audit_log_created ON tablebase_audit_log(created_at);
CREATE INDEX idx_audit_log_session ON tablebase_audit_log(agent_session_id);
CREATE INDEX idx_audit_log_type ON tablebase_audit_log(record_type);

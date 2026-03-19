CREATE TABLE qa_page_checks (
  id          BIGSERIAL PRIMARY KEY,
  thing_id    TEXT REFERENCES things(id) ON DELETE SET NULL,
  page_url    TEXT NOT NULL,
  directory   TEXT,
  check_type  TEXT NOT NULL DEFAULT 'detail',
  result      TEXT NOT NULL,
  findings    JSONB,
  depth       TEXT,
  sweep_id    TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qpc_thing ON qa_page_checks (thing_id);
CREATE INDEX idx_qpc_page_url ON qa_page_checks (page_url);
CREATE INDEX idx_qpc_directory ON qa_page_checks (directory);
CREATE INDEX idx_qpc_checked_at ON qa_page_checks (checked_at DESC);
CREATE INDEX idx_qpc_sweep ON qa_page_checks (sweep_id);

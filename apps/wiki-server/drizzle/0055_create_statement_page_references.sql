-- Statement-to-page references — links a statement to every wiki page it appears on.
-- Mirrors claim_page_references for the new statements system.

CREATE TABLE IF NOT EXISTS statement_page_references (
  id BIGSERIAL PRIMARY KEY,
  statement_id BIGINT REFERENCES statements(id) ON DELETE CASCADE,
  page_id_int INTEGER REFERENCES wiki_pages(integer_id_col),
  footnote_resource_id VARCHAR,
  section TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spr_page ON statement_page_references(page_id_int);
CREATE INDEX IF NOT EXISTS idx_spr_statement ON statement_page_references(statement_id);

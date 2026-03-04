-- Statement-to-page references — links a statement to every wiki page it appears on.
-- Mirrors claim_page_references for the new statements system.

CREATE TABLE IF NOT EXISTS statement_page_references (
  id BIGSERIAL PRIMARY KEY,
  statement_id BIGINT NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  page_id_int INTEGER NOT NULL REFERENCES wiki_pages(integer_id) ON DELETE CASCADE,
  footnote_resource_id VARCHAR,
  section TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spr_page ON statement_page_references(page_id_int);
CREATE INDEX IF NOT EXISTS idx_spr_statement ON statement_page_references(statement_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spr_stmt_page_footnote ON statement_page_references(statement_id, page_id_int, COALESCE(footnote_resource_id, ''));

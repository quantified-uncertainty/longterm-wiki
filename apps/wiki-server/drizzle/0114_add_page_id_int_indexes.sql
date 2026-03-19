-- Migration 0104: Add page_id_int indexes for hot-path FK columns
--
-- 7 tables have page_id_int FK columns used in hot-path queries but no indexes.
-- Only agent_session_pages already had one (idx_asp_page_id_int).
-- These indexes accelerate per-page lookups on citations, edit logs,
-- hallucination risk, session pages, auto-update news, and resource citations.
-- See GitHub issues #2684.

CREATE INDEX IF NOT EXISTS idx_cq_page_id_int ON citation_quotes (page_id_int);
CREATE INDEX IF NOT EXISTS idx_cas_page_id_int ON citation_accuracy_snapshots (page_id_int);
CREATE INDEX IF NOT EXISTS idx_el_page_id_int ON edit_logs (page_id_int);
CREATE INDEX IF NOT EXISTS idx_hrs_page_id_int ON hallucination_risk_snapshots (page_id_int);
CREATE INDEX IF NOT EXISTS idx_sp_page_id_int ON session_pages (page_id_int);
CREATE INDEX IF NOT EXISTS idx_auni_routed_page_id_int ON auto_update_news_items (routed_to_page_id_int);
CREATE INDEX IF NOT EXISTS idx_rc_page_id_int ON resource_citations (page_id_int);

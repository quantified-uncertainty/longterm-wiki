-- Phase D2b: Drop page_id_old (and source/target_id_old) columns
-- Epic: #1497 (Convert wiki_pages.id from text slug to integer PK)
--
-- Run scripts/phase-d2b-predeploy.sql first to verify 100% integer ID coverage
-- across all 8 tables before applying this migration.
--
-- Tables NOT included here (deferred — complex PK migration required):
--   citation_quotes, session_pages, resource_citations
--
-- These DROP COLUMN operations require ACCESS EXCLUSIVE locks. On production,
-- apply this migration during low-traffic windows or via a managed migration slot.

ALTER TABLE citation_accuracy_snapshots DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE edit_logs DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE hallucination_risk_snapshots DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE auto_update_results DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE claim_page_references DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE page_improve_runs DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE page_citations DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE page_links DROP COLUMN IF EXISTS source_id_old;
ALTER TABLE page_links DROP COLUMN IF EXISTS target_id_old;

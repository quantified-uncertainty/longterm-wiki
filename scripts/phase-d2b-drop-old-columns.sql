-- Phase D2b: Drop all page_id_old / source_id_old / target_id_old / routed_to_page_id_old columns.
--
-- Run this via psql AFTER Phase D2a code is deployed and verified.
-- All write paths stopped using these columns in Phase D2a.
-- All read paths were migrated to page_id_int (with LEFT JOIN wiki_pages for slug recovery).
--
-- Usage:
--   psql $DATABASE_URL -f scripts/phase-d2b-drop-old-columns.sql
--
-- Discussion #1497 — Phase D2b

BEGIN;

-- ============================================================
-- 1. Drop indexes on _old columns (must be dropped before columns)
-- ============================================================

-- Regular indexes
DROP INDEX IF EXISTS idx_cq_page_id;                    -- citation_quotes.page_id_old
DROP INDEX IF EXISTS idx_cas_page_id;                    -- citation_accuracy_snapshots.page_id_old
DROP INDEX IF EXISTS idx_el_page_id;                     -- edit_logs.page_id_old
DROP INDEX IF EXISTS idx_hrs_page_id;                    -- hallucination_risk_snapshots.page_id_old
DROP INDEX IF EXISTS idx_sp_page_id;                     -- session_pages.page_id_old
DROP INDEX IF EXISTS idx_aures_page_id;                  -- auto_update_results.page_id_old
DROP INDEX IF EXISTS idx_cpr_page_id;                    -- claim_page_references.page_id_old
DROP INDEX IF EXISTS idx_rc_page_id;                     -- resource_citations.page_id_old
DROP INDEX IF EXISTS idx_pl_source_id;                   -- page_links.source_id_old
DROP INDEX IF EXISTS idx_pl_target_id;                   -- page_links.target_id_old
DROP INDEX IF EXISTS idx_asp_page_id;                    -- auto_suggested_pages.page_id_old
DROP INDEX IF EXISTS idx_auni_routed_page;               -- auto_update_news_items.routed_to_page_id_old

-- Legacy unique index (replaced by citation_quotes_page_id_int_footnote_unique in Phase D2a)
DROP INDEX IF EXISTS citation_quotes_page_id_footnote_unique;

-- Legacy page_links unique index on text columns (replaced by page_links_source_target_int_unique)
DROP INDEX IF EXISTS page_links_source_target_type_unique;
DROP INDEX IF EXISTS idx_pl_source_target_type;

-- ============================================================
-- 2. Drop _old columns from all 12 FK tables
-- ============================================================

-- citation_quotes
ALTER TABLE citation_quotes DROP COLUMN IF EXISTS page_id_old;

-- citation_accuracy_snapshots
ALTER TABLE citation_accuracy_snapshots DROP COLUMN IF EXISTS page_id_old;

-- edit_logs
ALTER TABLE edit_logs DROP COLUMN IF EXISTS page_id_old;

-- hallucination_risk_snapshots
ALTER TABLE hallucination_risk_snapshots DROP COLUMN IF EXISTS page_id_old;

-- session_pages
ALTER TABLE session_pages DROP COLUMN IF EXISTS page_id_old;

-- auto_update_results
ALTER TABLE auto_update_results DROP COLUMN IF EXISTS page_id_old;

-- claim_page_references
ALTER TABLE claim_page_references DROP COLUMN IF EXISTS page_id_old;

-- resource_citations
ALTER TABLE resource_citations DROP COLUMN IF EXISTS page_id_old;

-- page_links (two columns)
ALTER TABLE page_links DROP COLUMN IF EXISTS source_id_old;
ALTER TABLE page_links DROP COLUMN IF EXISTS target_id_old;

-- auto_update_news_items
ALTER TABLE auto_update_news_items DROP COLUMN IF EXISTS routed_to_page_id_old;

-- page_improve_runs
ALTER TABLE page_improve_runs DROP COLUMN IF EXISTS page_id_old;

-- page_citations
ALTER TABLE page_citations DROP COLUMN IF EXISTS page_id_old;

COMMIT;

-- ============================================================
-- 3. Verification
-- ============================================================

-- Must return 0 rows:
SELECT column_name, table_name
FROM information_schema.columns
WHERE column_name LIKE '%_old'
  AND table_schema = 'public';

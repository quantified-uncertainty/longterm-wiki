-- Phase D3+E: Swap wiki_pages PK from text to integer + rename all _int columns
--
-- WARNING: Between running this script and deploying the new code,
-- the wiki-server will return 500 errors for any requests touching
-- renamed columns. Minimize this window by deploying immediately after.
-- Consider putting the server in maintenance mode during migration.
--
-- Run this via psql BEFORE deploying the Phase D3+E code changes.
-- Use: PGOPTIONS="-c statement_timeout=0" psql "$PRODUCTION_DB_URL" -f scripts/phase-d3e-pk-swap.sql
--
-- Discussion #1497 — Phase D3+E (point of no return)

BEGIN;

-- ============================================================
-- 1. Handle agent_session_pages (has text FK + composite PK on text page_id)
-- ============================================================

-- Drop FK: agent_session_pages.page_id → wiki_pages.id (text)
ALTER TABLE agent_session_pages DROP CONSTRAINT IF EXISTS agent_session_pages_page_id_fkey;
-- Drop composite PK: (agent_session_id, page_id) where page_id is text
ALTER TABLE agent_session_pages DROP CONSTRAINT IF EXISTS agent_session_pages_pkey;
-- Drop the text page_id column
ALTER TABLE agent_session_pages DROP COLUMN IF EXISTS page_id;
-- Rename page_id_int → page_id
ALTER TABLE agent_session_pages RENAME COLUMN page_id_int TO page_id;
-- Make it NOT NULL
ALTER TABLE agent_session_pages ALTER COLUMN page_id SET NOT NULL;
-- Recreate composite PK on (agent_session_id, page_id) where page_id is now integer
ALTER TABLE agent_session_pages ADD PRIMARY KEY (agent_session_id, page_id);

-- ============================================================
-- 2. Swap wiki_pages PK from text to integer
-- ============================================================

-- Pre-validate: abort if any wiki_pages rows have NULL integer_id
DO $$
DECLARE null_count INTEGER;
BEGIN
  SELECT count(*) INTO null_count FROM wiki_pages WHERE integer_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % wiki_pages rows have NULL integer_id — backfill required before PK swap', null_count;
  END IF;
END $$;

-- Drop text PK
ALTER TABLE wiki_pages DROP CONSTRAINT wiki_pages_pkey;
-- Drop unique constraint on integer_id (will become PK instead)
ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_integer_id_unique;
DROP INDEX IF EXISTS wiki_pages_integer_id_unique;
-- Make integer_id NOT NULL (required for PK)
ALTER TABLE wiki_pages ALTER COLUMN integer_id SET NOT NULL;
-- Rename: text id → id_old_text (temp), integer_id → id
ALTER TABLE wiki_pages RENAME COLUMN id TO id_old_text;
ALTER TABLE wiki_pages RENAME COLUMN integer_id TO id;
-- Add integer PK
ALTER TABLE wiki_pages ADD PRIMARY KEY (id);
-- Drop the old text id column (redundant with slug)
ALTER TABLE wiki_pages DROP COLUMN id_old_text;

-- ============================================================
-- 3. Rename _int columns across all FK tables
-- ============================================================

-- citation_quotes
ALTER TABLE citation_quotes RENAME COLUMN page_id_int TO page_id;

-- citation_accuracy_snapshots
ALTER TABLE citation_accuracy_snapshots RENAME COLUMN page_id_int TO page_id;

-- edit_logs
ALTER TABLE edit_logs RENAME COLUMN page_id_int TO page_id;

-- hallucination_risk_snapshots
ALTER TABLE hallucination_risk_snapshots RENAME COLUMN page_id_int TO page_id;

-- session_pages
ALTER TABLE session_pages RENAME COLUMN page_id_int TO page_id;

-- auto_update_results
ALTER TABLE auto_update_results RENAME COLUMN page_id_int TO page_id;

-- resource_citations
ALTER TABLE resource_citations RENAME COLUMN page_id_int TO page_id;

-- page_links (two columns)
ALTER TABLE page_links RENAME COLUMN source_id_int TO source_id;
ALTER TABLE page_links RENAME COLUMN target_id_int TO target_id;

-- auto_update_news_items
ALTER TABLE auto_update_news_items RENAME COLUMN routed_to_page_id_int TO routed_to_page_id;

-- page_improve_runs
ALTER TABLE page_improve_runs RENAME COLUMN page_id_int TO page_id;

-- page_citations
ALTER TABLE page_citations RENAME COLUMN page_id_int TO page_id;

-- wikibase_page_similarity
ALTER TABLE wikibase_page_similarity RENAME COLUMN page_id_int TO page_id;
ALTER TABLE wikibase_page_similarity RENAME COLUMN similar_page_id_int TO similar_page_id;

-- wikibase_page_assessments
ALTER TABLE wikibase_page_assessments RENAME COLUMN page_id_int TO page_id;

-- _archived_claim_page_references (archived table)
ALTER TABLE _archived_claim_page_references RENAME COLUMN page_id_int TO page_id;

-- _archived_statement_page_references (archived table)
ALTER TABLE _archived_statement_page_references RENAME COLUMN page_id_int TO page_id;

-- ============================================================
-- 4. Add FK from agent_session_pages.page_id → wiki_pages.id (integer)
-- ============================================================
ALTER TABLE agent_session_pages
  ADD CONSTRAINT agent_session_pages_page_id_fkey
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE;

-- ============================================================
-- 5. Rename indexes to clean names
-- ============================================================

ALTER INDEX IF EXISTS idx_cq_page_id_int RENAME TO idx_cq_page_id;
ALTER INDEX IF EXISTS citation_quotes_page_id_int_footnote_unique RENAME TO citation_quotes_page_id_footnote_unique;
ALTER INDEX IF EXISTS idx_cas_page_id_int RENAME TO idx_cas_page_id;
ALTER INDEX IF EXISTS idx_el_page_id_int RENAME TO idx_el_page_id;
ALTER INDEX IF EXISTS idx_hrs_page_id_int RENAME TO idx_hrs_page_id;
ALTER INDEX IF EXISTS idx_sp_page_id_int RENAME TO idx_sp_page_id;
ALTER INDEX IF EXISTS idx_aures_page_id_int RENAME TO idx_aures_page_id;
ALTER INDEX IF EXISTS idx_rc_page_id_int RENAME TO idx_rc_page_id;
ALTER INDEX IF EXISTS idx_pl_source_id_int RENAME TO idx_pl_source_id;
ALTER INDEX IF EXISTS idx_pl_target_id_int RENAME TO idx_pl_target_id;
ALTER INDEX IF EXISTS page_links_source_target_int_unique RENAME TO page_links_source_target_unique;
ALTER INDEX IF EXISTS idx_auni_routed_page_id_int RENAME TO idx_auni_routed_page_id;
ALTER INDEX IF EXISTS idx_auni_routed_page_int RENAME TO idx_auni_routed_page;
ALTER INDEX IF EXISTS idx_pc_page_id_int RENAME TO idx_pc_page_id;
ALTER INDEX IF EXISTS idx_pir_page_id_int RENAME TO idx_pir_page_id;
ALTER INDEX IF EXISTS idx_asp_page_id_int RENAME TO idx_asp_page_id;
ALTER INDEX IF EXISTS idx_cpr_page_id_int RENAME TO idx_cpr_page_id;

COMMIT;

-- ============================================================
-- 6. Recreate materialized views (outside transaction for CONCURRENTLY support)
-- ============================================================

-- hallucination_risk_latest (page_id_int renamed to page_id)
DROP MATERIALIZED VIEW IF EXISTS hallucination_risk_latest;
CREATE MATERIALIZED VIEW hallucination_risk_latest AS
SELECT DISTINCT ON (page_id) id,
    page_id,
    score,
    level,
    factors,
    integrity_issues,
    computed_at
FROM hallucination_risk_snapshots
ORDER BY page_id, computed_at DESC;

-- Recreate indexes that were on the old view
CREATE UNIQUE INDEX idx_hrl_page_id ON hallucination_risk_latest (page_id);
CREATE INDEX idx_hrl_score ON hallucination_risk_latest (score DESC);
CREATE INDEX idx_hrl_level ON hallucination_risk_latest (level);

-- ============================================================
-- 7. Verification
-- ============================================================

-- wiki_pages PK should be integer
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'wiki_pages' AND column_name IN ('id', 'slug')
ORDER BY column_name;

-- No _int columns should remain
SELECT column_name, table_name
FROM information_schema.columns
WHERE column_name LIKE '%_int'
  AND table_schema = 'public'
  AND table_name NOT LIKE '_archived%';

-- agent_session_pages.page_id should be integer with FK
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'agent_session_pages'::regclass;

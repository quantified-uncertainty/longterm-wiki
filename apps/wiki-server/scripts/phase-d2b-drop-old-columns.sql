-- Phase D2b: Drop all _old text columns from FK tables
-- Run via: psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/phase-d2b-drop-old-columns.sql
-- Prerequisites: D2a deployed (no code writes to _old columns)
-- Discussion: #1497

BEGIN;

-- 1. session_pages: must redefine PK before dropping column
--    Old PK: (session_id, page_id_old)
--    New PK: (session_id, page_id_int)
ALTER TABLE session_pages DROP CONSTRAINT IF EXISTS session_pages_pkey;
ALTER TABLE session_pages ADD PRIMARY KEY (session_id, page_id_int);

-- 2. Drop all FK constraints on _old columns
-- (Use DO block to handle constraints that may not exist)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN (
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE confrelid = 'wiki_pages'::regclass
      AND (conname LIKE '%page_id_old%'
        OR conname LIKE '%source_id_old%'
        OR conname LIKE '%target_id_old%'
        OR conname LIKE '%routed_to_page_id_old%')
  ) LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.conname);
    RAISE NOTICE 'Dropped FK: %.%', r.table_name, r.conname;
  END LOOP;
END $$;

-- 3. Drop indexes on _old columns
-- citation_quotes
DROP INDEX IF EXISTS idx_cq_page_id;
-- citation_accuracy_snapshots
DROP INDEX IF EXISTS idx_cas_page_id;
-- edit_logs
DROP INDEX IF EXISTS idx_el_page_id;
-- hallucination_risk_snapshots
DROP INDEX IF EXISTS idx_hrs_page_id;
-- session_pages
DROP INDEX IF EXISTS idx_sp_page_id;
-- auto_update_results
DROP INDEX IF EXISTS idx_aures_page_id;
-- auto_update_news_items
DROP INDEX IF EXISTS idx_auni_routed_page;
-- claim_page_references (archived)
DROP INDEX IF EXISTS idx_cpr_page_id;
DROP INDEX IF EXISTS idx_cpr_claim_page_footnote;
-- page_citations
DROP INDEX IF EXISTS idx_pc_page_id;
-- resource_citations
DROP INDEX IF EXISTS idx_rc_page_id;
-- page_links
DROP INDEX IF EXISTS idx_pl_source_id;
DROP INDEX IF EXISTS idx_pl_target_id;
DROP INDEX IF EXISTS idx_pl_source_target_type;
-- page_improve_runs
DROP INDEX IF EXISTS idx_pir_page_id;
DROP INDEX IF EXISTS idx_pir_page_started;
-- citation_quotes legacy unique index
DROP INDEX IF EXISTS citation_quotes_page_id_footnote_unique;

-- 4. Create replacement indexes on _int columns where needed
--    (Some already exist from Phase B migrations; CREATE IF NOT EXISTS handles duplicates)
CREATE INDEX IF NOT EXISTS idx_pl_source_id_int ON page_links (source_id_int);
CREATE INDEX IF NOT EXISTS idx_pl_target_id_int ON page_links (target_id_int);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pl_source_target_type_int
  ON page_links (source_id_int, target_id_int, link_type);
CREATE INDEX IF NOT EXISTS idx_pir_page_id_int ON page_improve_runs (page_id_int);
CREATE INDEX IF NOT EXISTS idx_pir_page_started_int ON page_improve_runs (page_id_int, started_at);
CREATE INDEX IF NOT EXISTS idx_pc_page_id_int ON page_citations (page_id_int);
CREATE INDEX IF NOT EXISTS idx_aures_page_id_int ON auto_update_results (page_id_int);
CREATE INDEX IF NOT EXISTS idx_cpr_page_id_int ON _archived_claim_page_references (page_id_int);

-- 5. Drop the _old columns
ALTER TABLE citation_quotes DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE citation_accuracy_snapshots DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE edit_logs DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE hallucination_risk_snapshots DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE session_pages DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE auto_update_results DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE _archived_claim_page_references DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE resource_citations DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE page_links DROP COLUMN IF EXISTS source_id_old;
ALTER TABLE page_links DROP COLUMN IF EXISTS target_id_old;
ALTER TABLE auto_update_news_items DROP COLUMN IF EXISTS routed_to_page_id_old;
ALTER TABLE page_improve_runs DROP COLUMN IF EXISTS page_id_old;
ALTER TABLE page_citations DROP COLUMN IF EXISTS page_id_old;

COMMIT;

-- Verification queries (run after commit):
-- Should return 0 rows:
-- SELECT column_name, table_name FROM information_schema.columns
--   WHERE column_name LIKE '%_old' AND table_schema = 'public';

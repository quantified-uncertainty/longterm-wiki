-- Phase 4a: Add slug/integer_id to wiki_pages + page_id_int to FK tables
-- Epic: #1497 (Convert wiki_pages.id from text slug to integer PK)
-- Issue: #1498
--
-- This script must be run directly via psql (NOT through Drizzle migrations)
-- because ALTER TABLE requires ACCESS EXCLUSIVE locks that conflict with the
-- pre-deploy smoke test's concurrent connections.
--
-- Usage:
--   psql "$DATABASE_URL" -f apps/wiki-server/scripts/phase4a-manual-migration.sql
--
-- Safe to re-run: all DDL uses IF NOT EXISTS, backfills use WHERE ... IS NULL,
-- and constraints use EXCEPTION handlers.

BEGIN;

-- ============================================================
-- Step 1: Add slug and integer_id columns to wiki_pages
-- ============================================================

ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS integer_id integer;

-- ============================================================
-- Step 2: Auto-allocate entity_ids for any pages missing them
-- ============================================================

INSERT INTO entity_ids (numeric_id, slug)
SELECT nextval('entity_id_seq'), wp.id
FROM wiki_pages wp
LEFT JOIN entity_ids ei ON ei.slug = wp.id
WHERE ei.numeric_id IS NULL
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Step 3: Backfill wiki_pages.slug and integer_id
-- ============================================================

UPDATE wiki_pages SET slug = id WHERE slug IS NULL;

UPDATE wiki_pages wp
SET integer_id = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = wp.id AND wp.integer_id IS NULL;

-- ============================================================
-- Step 4: Apply NOT NULL + UNIQUE constraints (idempotent)
-- ============================================================

DO $$ BEGIN
  ALTER TABLE wiki_pages ALTER COLUMN slug SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_slug_unique UNIQUE (slug);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_integer_id_unique UNIQUE (integer_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Step 5: Add page_id_int columns to 11 FK tables (nullable)
-- ============================================================

ALTER TABLE citation_quotes ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE citation_accuracy_snapshots ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE edit_logs ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE hallucination_risk_snapshots ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE session_pages ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE auto_update_results ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE claim_page_references ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE resource_citations ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE auto_update_news_items ADD COLUMN IF NOT EXISTS routed_to_page_id_int integer;
ALTER TABLE page_improve_runs ADD COLUMN IF NOT EXISTS page_id_int integer;
ALTER TABLE page_citations ADD COLUMN IF NOT EXISTS page_id_int integer;

-- ============================================================
-- Step 6: Add source_id_int and target_id_int to page_links
-- ============================================================

ALTER TABLE page_links ADD COLUMN IF NOT EXISTS source_id_int integer;
ALTER TABLE page_links ADD COLUMN IF NOT EXISTS target_id_int integer;

COMMIT;

-- ============================================================
-- Step 7: Backfill all _int columns (outside transaction for performance)
-- ============================================================

UPDATE citation_quotes cq SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = cq.page_id AND cq.page_id_int IS NULL;
UPDATE citation_accuracy_snapshots cas SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = cas.page_id AND cas.page_id_int IS NULL;
UPDATE edit_logs el SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = el.page_id AND el.page_id_int IS NULL;
UPDATE hallucination_risk_snapshots hrs SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = hrs.page_id AND hrs.page_id_int IS NULL;
UPDATE session_pages sp SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = sp.page_id AND sp.page_id_int IS NULL;
UPDATE auto_update_results aur SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = aur.page_id AND aur.page_id_int IS NULL;
UPDATE claim_page_references cpr SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = cpr.page_id AND cpr.page_id_int IS NULL;
UPDATE resource_citations rc SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = rc.page_id AND rc.page_id_int IS NULL;
UPDATE auto_update_news_items auni SET routed_to_page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = auni.routed_to_page_id AND auni.routed_to_page_id_int IS NULL;
UPDATE page_improve_runs pir SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = pir.page_id AND pir.page_id_int IS NULL;
UPDATE page_citations pc SET page_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = pc.page_id AND pc.page_id_int IS NULL;
UPDATE page_links pl SET source_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = pl.source_id AND pl.source_id_int IS NULL;
UPDATE page_links pl SET target_id_int = ei.numeric_id FROM entity_ids ei WHERE ei.slug = pl.target_id AND pl.target_id_int IS NULL;

-- ============================================================
-- Step 8: Create indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_cq_page_id_int ON citation_quotes (page_id_int);
CREATE INDEX IF NOT EXISTS idx_cas_page_id_int ON citation_accuracy_snapshots (page_id_int);
CREATE INDEX IF NOT EXISTS idx_el_page_id_int ON edit_logs (page_id_int);
CREATE INDEX IF NOT EXISTS idx_hrs_page_id_int ON hallucination_risk_snapshots (page_id_int);
CREATE INDEX IF NOT EXISTS idx_sp_page_id_int ON session_pages (page_id_int);
CREATE INDEX IF NOT EXISTS idx_aures_page_id_int ON auto_update_results (page_id_int);
CREATE INDEX IF NOT EXISTS idx_cpr_page_id_int ON claim_page_references (page_id_int);
CREATE INDEX IF NOT EXISTS idx_rc_page_id_int ON resource_citations (page_id_int);
CREATE INDEX IF NOT EXISTS idx_auni_routed_page_int ON auto_update_news_items (routed_to_page_id_int);
CREATE INDEX IF NOT EXISTS idx_pir_page_id_int ON page_improve_runs (page_id_int);
CREATE INDEX IF NOT EXISTS idx_pc_page_id_int ON page_citations (page_id_int);
CREATE INDEX IF NOT EXISTS idx_pl_source_id_int ON page_links (source_id_int);
CREATE INDEX IF NOT EXISTS idx_pl_target_id_int ON page_links (target_id_int);

-- ============================================================
-- Verification
-- ============================================================

SELECT 'wiki_pages columns' AS check,
  COUNT(*) FILTER (WHERE slug IS NOT NULL) AS slug_filled,
  COUNT(*) FILTER (WHERE integer_id IS NOT NULL) AS integer_id_filled,
  COUNT(*) AS total
FROM wiki_pages;

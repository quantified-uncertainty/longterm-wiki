-- Phase 4a: Expand schema for wiki_pages integer PK migration
-- Epic: #1497 (Convert wiki_pages.id from text slug to integer PK)
-- Issue: #1498
--
-- This migration:
--   1. Adds wiki_pages.slug (text) and wiki_pages.integer_id (integer)
--   2. Backfills both columns from existing data
--   3. Adds page_id_int columns to 11 FK tables
--   4. Adds source_id_int / target_id_int to page_links
--   5. Backfills all _int columns from entity_ids lookup
--
-- Fully revertible: DROP the new columns to restore the prior state.

-- ============================================================
-- Step 1: Add slug and integer_id columns to wiki_pages
-- ============================================================

ALTER TABLE wiki_pages ADD COLUMN slug text;
--> statement-breakpoint
ALTER TABLE wiki_pages ADD COLUMN integer_id integer;
--> statement-breakpoint

-- ============================================================
-- Step 2: Auto-allocate entity_ids for any pages missing them
-- ============================================================

INSERT INTO entity_ids (numeric_id, slug)
SELECT nextval('entity_id_seq'), wp.id
FROM wiki_pages wp
LEFT JOIN entity_ids ei ON ei.slug = wp.id
WHERE ei.numeric_id IS NULL
ON CONFLICT (slug) DO NOTHING;
--> statement-breakpoint

-- ============================================================
-- Step 3: Backfill wiki_pages.slug from id, integer_id from entity_ids
-- ============================================================

UPDATE wiki_pages SET slug = id;
--> statement-breakpoint

UPDATE wiki_pages wp
SET integer_id = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = wp.id;
--> statement-breakpoint

-- ============================================================
-- Step 4: Apply NOT NULL + UNIQUE constraints
-- slug is NOT NULL (always equals id). integer_id is nullable in Phase 4a
-- (will become NOT NULL in Phase 4b once all rows are guaranteed populated).
--
-- NOTE: Drizzle's migrator runs all statements in a single transaction, so
-- CONCURRENTLY is not possible. These tables are small (~700 rows), so
-- brief locking during constraint/index creation is acceptable.
-- ============================================================

ALTER TABLE wiki_pages ALTER COLUMN slug SET NOT NULL;
--> statement-breakpoint
ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_slug_unique UNIQUE (slug);
--> statement-breakpoint
ALTER TABLE wiki_pages ADD CONSTRAINT wiki_pages_integer_id_unique UNIQUE (integer_id);
--> statement-breakpoint

-- ============================================================
-- Step 5: Add page_id_int columns to 11 FK tables (nullable)
-- ============================================================

ALTER TABLE citation_quotes ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE citation_accuracy_snapshots ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE edit_logs ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE hallucination_risk_snapshots ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE session_pages ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE auto_update_results ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE claim_page_references ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE resource_citations ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE auto_update_news_items ADD COLUMN routed_to_page_id_int integer;
--> statement-breakpoint
ALTER TABLE page_improve_runs ADD COLUMN page_id_int integer;
--> statement-breakpoint
ALTER TABLE page_citations ADD COLUMN page_id_int integer;
--> statement-breakpoint

-- ============================================================
-- Step 6: Add source_id_int and target_id_int to page_links
-- ============================================================

ALTER TABLE page_links ADD COLUMN source_id_int integer;
--> statement-breakpoint
ALTER TABLE page_links ADD COLUMN target_id_int integer;
--> statement-breakpoint

-- ============================================================
-- Step 7: Backfill all _int columns from entity_ids lookup
-- ============================================================

UPDATE citation_quotes cq
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = cq.page_id;
--> statement-breakpoint

UPDATE citation_accuracy_snapshots cas
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = cas.page_id;
--> statement-breakpoint

UPDATE edit_logs el
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = el.page_id;
--> statement-breakpoint

UPDATE hallucination_risk_snapshots hrs
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = hrs.page_id;
--> statement-breakpoint

UPDATE session_pages sp
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = sp.page_id;
--> statement-breakpoint

UPDATE auto_update_results aur
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = aur.page_id;
--> statement-breakpoint

UPDATE claim_page_references cpr
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = cpr.page_id;
--> statement-breakpoint

UPDATE resource_citations rc
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = rc.page_id;
--> statement-breakpoint

UPDATE auto_update_news_items auni
SET routed_to_page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = auni.routed_to_page_id;
--> statement-breakpoint

UPDATE page_improve_runs pir
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = pir.page_id;
--> statement-breakpoint

UPDATE page_citations pc
SET page_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = pc.page_id;
--> statement-breakpoint

UPDATE page_links pl
SET source_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = pl.source_id;
--> statement-breakpoint

UPDATE page_links pl
SET target_id_int = ei.numeric_id
FROM entity_ids ei
WHERE ei.slug = pl.target_id;
--> statement-breakpoint

-- ============================================================
-- Step 8: Create indexes on new columns for query performance
-- (slug and integer_id already have implicit indexes from UNIQUE constraints)
-- ============================================================

CREATE INDEX idx_cq_page_id_int ON citation_quotes (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_cas_page_id_int ON citation_accuracy_snapshots (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_el_page_id_int ON edit_logs (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_hrs_page_id_int ON hallucination_risk_snapshots (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_sp_page_id_int ON session_pages (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_aures_page_id_int ON auto_update_results (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_cpr_page_id_int ON claim_page_references (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_rc_page_id_int ON resource_citations (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_auni_routed_page_int ON auto_update_news_items (routed_to_page_id_int);
--> statement-breakpoint
CREATE INDEX idx_pir_page_id_int ON page_improve_runs (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_pc_page_id_int ON page_citations (page_id_int);
--> statement-breakpoint
CREATE INDEX idx_pl_source_id_int ON page_links (source_id_int);
--> statement-breakpoint
CREATE INDEX idx_pl_target_id_int ON page_links (target_id_int);

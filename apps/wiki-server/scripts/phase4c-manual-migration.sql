-- Phase 4c: Rename text page_id columns to page_id_old across all FK tables
-- Epic: #1497 (Convert wiki_pages.id from text slug to integer PK)
-- Issue: #1498
--
-- Renames the legacy text slug columns so it is clear they are transitional.
-- The integer _int columns (added in Phase 4a) are now the primary read path.
-- Phase 4d will drop these _old columns once all remaining write paths are
-- migrated to use integer PKs only.
--
-- This script must be run directly via psql (NOT through Drizzle migrations)
-- because RENAME COLUMN requires ACCESS EXCLUSIVE locks that conflict with the
-- pre-deploy smoke test's concurrent connections.
--
-- Usage:
--   psql "$DATABASE_URL" -f apps/wiki-server/scripts/phase4c-manual-migration.sql
--
-- Safe to re-run: all renames are inside DO $$ ... EXCEPTION handlers so they
-- are no-ops if the column has already been renamed.

BEGIN;

-- ============================================================
-- citation_quotes: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE citation_quotes RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- citation_accuracy_snapshots: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE citation_accuracy_snapshots RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- edit_logs: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE edit_logs RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- hallucination_risk_snapshots: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE hallucination_risk_snapshots RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- session_pages: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE session_pages RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- auto_update_results: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE auto_update_results RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- claim_page_references: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE claim_page_references RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- resource_citations: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE resource_citations RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- auto_update_news_items: routed_to_page_id → routed_to_page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE auto_update_news_items RENAME COLUMN routed_to_page_id TO routed_to_page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- page_improve_runs: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE page_improve_runs RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- page_citations: page_id → page_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE page_citations RENAME COLUMN page_id TO page_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

-- ============================================================
-- page_links: source_id → source_id_old, target_id → target_id_old
-- ============================================================

DO $$ BEGIN
  ALTER TABLE page_links RENAME COLUMN source_id TO source_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE page_links RENAME COLUMN target_id TO target_id_old;
EXCEPTION WHEN undefined_column THEN NULL;
END $$;

COMMIT;

-- ============================================================
-- Verification
-- ============================================================

SELECT 'citation_quotes' AS table_name,
  COUNT(*) FILTER (WHERE page_id_old IS NOT NULL) AS old_col_filled,
  COUNT(*) FILTER (WHERE page_id_int IS NOT NULL) AS int_col_filled,
  COUNT(*) AS total
FROM citation_quotes
UNION ALL
SELECT 'page_links',
  COUNT(*) FILTER (WHERE source_id_old IS NOT NULL),
  COUNT(*) FILTER (WHERE source_id_int IS NOT NULL),
  COUNT(*)
FROM page_links;

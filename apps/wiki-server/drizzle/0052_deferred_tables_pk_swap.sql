-- Phase D2a (deferred): Migrate PK/UNIQUE constraints to integer columns
-- Epic: #1497 (Convert wiki_pages.id from text slug to integer PK)
--
-- Deferred from PR #1543 because these 3 tables had _old columns load-bearing
-- in PKs or UNIQUE constraints. Now that page_id_int is fully populated,
-- we can migrate the constraints and make page_id_old nullable.
--
-- Tables migrated:
--   citation_quotes: UNIQUE(page_id_old, footnote) → UNIQUE(page_id_int, footnote)
--   session_pages:   PK(session_id, page_id_old)  → PK(session_id, page_id_int)
--   resource_citations: PK(resource_id, page_id_old) → PK(resource_id, page_id_int)
--
-- NOTE: The CONCURRENTLY index for citation_quotes must be run via
-- scripts/phase-d2a-deferred-predeploy.sql (it cannot run inside a transaction).
-- This migration assumes that script has already been applied.

--> statement-breakpoint
-- citation_quotes: drop old text-based unique constraint, make page_id_old nullable
DROP INDEX IF EXISTS citation_quotes_page_id_footnote_unique;
ALTER TABLE citation_quotes ALTER COLUMN page_id_old DROP NOT NULL;

--> statement-breakpoint
-- citation_quotes: fail fast if predeploy index is missing (avoids taking a non-concurrent lock
-- on citation_quotes which could block writes on large tables).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'citation_quotes'
      AND indexname = 'citation_quotes_page_id_int_footnote_unique'
  ) THEN
    RAISE EXCEPTION 'Missing predeploy index citation_quotes_page_id_int_footnote_unique. Run scripts/phase-d2a-deferred-predeploy.sql first.';
  END IF;
END $$;

--> statement-breakpoint
-- session_pages: swap PK to (session_id, page_id_int), make page_id_old nullable
ALTER TABLE session_pages DROP CONSTRAINT session_pages_pkey;
ALTER TABLE session_pages ADD PRIMARY KEY (session_id, page_id_int);
ALTER TABLE session_pages ALTER COLUMN page_id_old DROP NOT NULL;

--> statement-breakpoint
-- resource_citations: swap PK to (resource_id, page_id_int), make page_id_old nullable
ALTER TABLE resource_citations DROP CONSTRAINT resource_citations_pkey;
ALTER TABLE resource_citations ADD PRIMARY KEY (resource_id, page_id_int);
ALTER TABLE resource_citations ALTER COLUMN page_id_old DROP NOT NULL;

--> statement-breakpoint
-- citation_quotes: enforce NOT NULL on page_id_int now that predeploy script has verified 0 NULLs
-- (predeploy script checks for 0 NULL page_id_int rows before reaching this point)
ALTER TABLE citation_quotes ALTER COLUMN page_id_int SET NOT NULL;

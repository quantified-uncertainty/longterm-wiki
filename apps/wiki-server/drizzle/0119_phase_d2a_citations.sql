-- Phase D2a: Stop writing page_id_old in citation_quotes and resource_citations.
-- These DDL changes must be present for fresh DB bootstraps (integration tests, new deployments).
-- On production, the manual script (scripts/phase-d2a-citations-predeploy.sql) applies
-- the same changes with verification checks and CONCURRENTLY index creation.

-- 1. citation_quotes.page_id_old: DROP NOT NULL
ALTER TABLE "citation_quotes" ALTER COLUMN "page_id_old" DROP NOT NULL;

-- 2. resource_citations.page_id_int: SET NOT NULL
ALTER TABLE "resource_citations" ALTER COLUMN "page_id_int" SET NOT NULL;

-- 3. resource_citations: migrate PK from (resource_id, page_id_old) to (resource_id, page_id_int)
ALTER TABLE "resource_citations" DROP CONSTRAINT "resource_citations_resource_id_page_id_pk";
ALTER TABLE "resource_citations" ADD PRIMARY KEY ("resource_id", "page_id_int");

-- 4. resource_citations.page_id_old: DROP NOT NULL
ALTER TABLE "resource_citations" ALTER COLUMN "page_id_old" DROP NOT NULL;

-- 5. citation_quotes: CREATE UNIQUE INDEX (page_id_int, footnote)
--    Replaces (page_id_old, footnote) for ON CONFLICT usage.
CREATE UNIQUE INDEX IF NOT EXISTS "citation_quotes_page_id_int_footnote_unique"
  ON "citation_quotes" ("page_id_int", "footnote");

-- Phase D2a: Stop writing page_id_old in citation_quotes and resource_citations.
-- This is a no-op migration: the actual DDL changes are applied via the manual
-- predeploy script (scripts/phase-d2a-citations-predeploy.sql) on production,
-- where the page_id_old columns exist. On fresh DBs (CI, integration tests),
-- the schema already reflects the final state so no DDL is needed.
SELECT 1;

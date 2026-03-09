-- Archive statements/claims tables (data preserved, just renamed)
-- The server routes for /api/statements and /api/claims have been deleted.
-- Tables are renamed with _archived_ prefix so data can be recovered if needed.

-- 1. Drop FK from citation_quotes.claim_id → claims.id first
--    (citation_quotes stays live, but the FK target is being archived)
ALTER TABLE IF EXISTS citation_quotes DROP CONSTRAINT IF EXISTS citation_quotes_claim_id_claims_id_fk;

-- 2. Archive statements system tables
ALTER TABLE IF EXISTS statement_citations RENAME TO _archived_statement_citations;
ALTER TABLE IF EXISTS statement_page_references RENAME TO _archived_statement_page_references;
ALTER TABLE IF EXISTS statements RENAME TO _archived_statements;
ALTER TABLE IF EXISTS entity_coverage_scores RENAME TO _archived_entity_coverage_scores;

-- 3. Archive claims system tables
ALTER TABLE IF EXISTS claim_sources RENAME TO _archived_claim_sources;
ALTER TABLE IF EXISTS claim_page_references RENAME TO _archived_claim_page_references;
ALTER TABLE IF EXISTS claims RENAME TO _archived_claims;

-- Keep the properties table — it may be reused by KB

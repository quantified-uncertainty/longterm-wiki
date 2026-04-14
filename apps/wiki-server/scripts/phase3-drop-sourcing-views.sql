-- QUA-303 Phase 3: drop back-compat views after the grace period.
-- DRAFT — see docs/audits/qua-303-sourcing-rename-audit.md.
--
-- Run only after ≥7 days of Phase 2 (code update) being deployed AND after confirming
-- via pg_stat_statements (or application logs) that no queries are still hitting the
-- legacy view names.
--
-- Verification query to run BEFORE this script:
--   SELECT query, calls FROM pg_stat_statements
--   WHERE query ILIKE '%source_check_evidence%' OR query ILIKE '%source_check_verdicts%'
--   ORDER BY calls DESC;
-- Expect zero rows, or only the smoke-test INSERT/DELETE from Phase 1.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP VIEW IF EXISTS source_check_evidence;
DROP VIEW IF EXISTS source_check_verdicts;

COMMIT;

-- Post-run verification:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND (table_name ILIKE 'source_check%' OR table_name ILIKE 'sourcing_%')
--   ORDER BY table_name;
-- Expect: sourcing_evidence, sourcing_url_suggestions, sourcing_verdicts.
-- (source_check_evidence and source_check_verdicts should NOT appear.)

-- QUA-303 Phase 3: drop back-compat views after the grace period.
-- DRAFT — see docs/audits/qua-303-sourcing-rename-audit.md.
--
-- Run only after ≥7 days of Phase 2 (code update) being deployed AND after confirming
-- that no queries are still hitting the legacy view names.
--
-- Observability options (pg_stat_statements is NOT currently installed in prod):
--   1. Postgres logs: enable `log_statement = 'mod'` temporarily and grep for the
--      view names, or filter existing slow-query logs.
--   2. Application logs: grep wiki-server / groundskeeper / crux job logs for the
--      legacy identifiers. Phase 2 renames them out of source code, so any hit after
--      the Phase 2 deploy indicates a missed call site.
--   3. Codebase double-check: `grep -rn "source_check_evidence\|source_check_verdicts"
--      --include="*.ts" --include="*.sql"` should return only historical Drizzle
--      migrations and this script's own comments.
--   4. Install pg_stat_statements ad-hoc if deeper observability is needed:
--      `CREATE EXTENSION pg_stat_statements;` — requires shared_preload_libraries setting.
--
-- The views are auto-updatable, so an app pod querying them will succeed transparently —
-- there is no error signal to rely on. The verification is proactive, not reactive.

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

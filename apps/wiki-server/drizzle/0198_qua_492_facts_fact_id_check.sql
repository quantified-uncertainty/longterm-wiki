-- QUA-492 (QUA-408 Phase 1 closeout, facts half): CHECK constraint on
-- facts.fact_id to enforce canonical `f_<10-char alnum>` format.
--
-- The 248-ID migration to canonical format landed 2026-04-03 (commit
-- b52551357) and was completed by QUA-497 (merged 2026-04-16, PR #4375)
-- which migrated the last 776 bare10 IDs. This migration locks the door:
-- non-canonical rows can no longer be inserted or updated.
--
-- Resources-side CHECK constraints (resources.stable_id,
-- entity_resources.resource_id, resources.id) remain blocked on QUA-549
-- Phase B completion and are intentionally out of scope here, per the
-- 2026-04-16 rescope comment on QUA-492.
--
-- ## Prod enumeration (2026-04-18, per .claude/rules/database-migrations.md
--   § "Adding CHECK constraints on enum columns")
--
-- /internal/data-quality snapshot #20 (2026-04-18T06:00:01Z):
--
--   facts.fact_id distribution (total 2274):
--     canonical_f    (^f_[A-Za-z0-9]{8,}$):  2274 (100%)
--     legacy_hex8    (^[0-9a-f]{8}$):           0
--     legacy_alnum10 (^[A-Za-z0-9]{10}$):       0
--     legacy_hex16   (^[0-9a-f]{16}$):          0
--     other:                                    0
--
-- YAML source enumeration (packages/factbase/data/fb-entities/*.yaml,
-- 2131 fact IDs): 100% match `^f_[A-Za-z0-9]{10}$` exactly — 12 chars total.
--
-- The generator (generateFactId() in packages/factbase/src/ids.ts) always
-- produces exactly 10 chars after the `f_` prefix. The data-quality audit
-- regex uses `{8,}` only to catch drift; this migration enforces the
-- strict `{10}` form that matches what the generator actually emits.
--
-- ## Safety
--
-- facts is small (2274 rows). No materialized view depends on it (verified
-- by grep for "MATERIALIZED VIEW.*facts" under apps/wiki-server/). Lock
-- contention risk is negligible.
--
-- The NOT VALID + VALIDATE CONSTRAINT split is not strictly necessary at
-- this size but is used for consistency with the pattern in
-- .claude/rules/database-migrations.md § "`ADD CONSTRAINT ... NOT VALID` +
-- separate `VALIDATE CONSTRAINT`" and to be future-proof as the table grows.
--
-- ADD CONSTRAINT is wrapped in a DO block with duplicate_object EXCEPTION
-- handling so the migration is idempotent — safe to re-run if interrupted.

-- 1. Register the CHECK constraint as unchecked metadata.
--    Acquires ACCESS EXCLUSIVE for milliseconds; no row scan.
DO $$ BEGIN
  ALTER TABLE "facts"
    ADD CONSTRAINT chk_facts_fact_id_format
    CHECK (fact_id ~ '^f_[A-Za-z0-9]{10}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Validate against existing rows.
--    Only needs SHARE UPDATE EXCLUSIVE — concurrent SELECT/INSERT/UPDATE
--    are allowed.
ALTER TABLE "facts" VALIDATE CONSTRAINT chk_facts_fact_id_format;

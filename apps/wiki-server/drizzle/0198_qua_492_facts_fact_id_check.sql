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
-- ## Prod enumeration (2026-04-18, per docs/agent-rules/database-migrations.md
--   § "Adding CHECK constraints on enum columns")
--
-- Strict-regex enumeration via /api/facts/export (pulls every fact_id
-- directly from PG, tests each against the constraint regex):
--
--   Total rows:                                  2274
--   Length distribution:                         {"12": 2274}  (f_ + 10 chars)
--   Strict violations (!~ '^f_[A-Za-z0-9]{10}$'):   0
--
-- Sanity cross-check via /internal/data-quality snapshot #20
-- (2026-04-18T06:00:01Z), looser `{8,}` regex: 2274/2274 in canonical_f bucket.
-- YAML source (packages/factbase/data/fb-entities/*.yaml, 2131 IDs): 100%
-- match `^f_[A-Za-z0-9]{10}$`.
--
-- The generator (generateFactId() in packages/factbase/src/ids.ts) always
-- produces exactly 10 chars after the `f_` prefix. The strict `{10}` regex
-- matches what the generator emits; VALIDATE CONSTRAINT is confirmed safe.
--
-- ## Lock profile + materialized-view dependency
--
-- facts is small (2274 rows). `ADD CONSTRAINT ... NOT VALID` needs ACCESS
-- EXCLUSIVE; `VALIDATE CONSTRAINT` needs SHARE UPDATE EXCLUSIVE.
--
-- The `things_search` materialized view (defined by migration 0190) reads
-- `FROM facts f` and is REFRESH'd (CONCURRENTLY) by the hourly job at
-- apps/wiki-server/src/routes/operational/things-search-refresh.ts with a
-- 180s statement_timeout. A REFRESH holds ACCESS SHARE on `facts`, which
-- conflicts with the ACCESS EXCLUSIVE that `ADD CONSTRAINT` acquires. The
-- migration client's default `lock_timeout` is 60s — not enough to survive
-- colliding with a long-running REFRESH. Same failure shape as QUA-302.
--
-- Mitigations:
--   1. `SET LOCAL lock_timeout = '180000'` (below) extends the wait to
--      match the REFRESH's statement_timeout.
--   2. facts is small enough that NOT VALID is milliseconds once the lock
--      is acquired, so the "wait-then-succeed" path is the common case.
--
-- ## Transaction semantics
--
-- Drizzle wraps each migration SQL file in a single transaction. That means
-- both ADD CONSTRAINT (NOT VALID) and VALIDATE CONSTRAINT run inside the
-- same transaction and the ACCESS EXCLUSIVE lock is held through VALIDATE.
-- For a 2274-row table this is inconsequential (validation is sub-second).
-- If `facts` grows large enough that VALIDATE becomes slow, this migration
-- should be split into two files (0193a NOT VALID, 0193b VALIDATE) so the
-- locks release between them. This is tracked in docs/agent-rules/database-migrations.md
-- § "ADD CONSTRAINT ... NOT VALID + separate VALIDATE CONSTRAINT".
--
-- ADD CONSTRAINT is wrapped in a DO block with duplicate_object EXCEPTION
-- handling so a manual re-apply (outside Drizzle) is a no-op instead of an
-- error. Drizzle itself tracks applied migrations in __drizzle_migrations
-- and won't re-run this file on startup.

-- Extend lock wait to tolerate an in-progress things_search REFRESH (180s
-- statement_timeout there). SET LOCAL only lasts for this transaction.
SET LOCAL lock_timeout = '180000';

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
--    are allowed (other than the ACCESS EXCLUSIVE already held from step 1
--    inside this transaction; see "Transaction semantics" above).
ALTER TABLE "facts" VALIDATE CONSTRAINT chk_facts_fact_id_format;

-- QUA-536 Phase A: populate NULL `resources.stable_id` + NOT NULL constraint.
--
-- Context: see Linear QUA-536 and the rescope comment for the enumeration
-- audit. Pre-flight (2026-04-16) counted ~17,764 rows where `stable_id IS NULL`
-- and ~4,769 rows where `resources.stable_id` is populated but `things.id` is
-- still the stale hex16 `resources.id` (pre-existing drift from before QUA-503).
-- This migration fixes both: it populates every NULL stable_id with a new
-- `sid_<10>` and aligns every `things.id` for `source_table='resources'` to
-- match the resource's canonical stable_id.
--
-- Usage (from a release session):
--   psql "$DATABASE_MIGRATION_URL" -v ON_ERROR_STOP=1 \
--     -f apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql
--
-- Pre-conditions verified by the script:
--   1. At least one NULL `resources.stable_id` row exists (else migration
--      already applied or pre-flight snapshot is stale).
--   2. Zero `^[A-Za-z0-9]{10}$` bare10 stable_ids (QUA-503 / migration 0182
--      cleared these). If this fires, a bare10 row reappeared since QUA-503
--      — halt and file a ticket.
--   3. The test-probe row (`id='test-resource-probe'`) is present as expected.
--
-- Post-conditions verified at the end:
--   1. Zero `resources.stable_id IS NULL` rows.
--   2. Every `resources.stable_id` matches `^sid_[A-Za-z0-9]{10}$`.
--   3. No duplicate `stable_id` values.
--   4. Zero `things` rows where `source_table='resources'` AND `id != r.stable_id`.
--
-- DDL on `things`: this script drops and re-adds the FKs that reference
-- `things.id`, matching the pattern from QUA-503 (migration 0182). PostgreSQL
-- does not support PK updates when referenced rows exist and the FKs are not
-- `ON UPDATE CASCADE`. We drop + UPDATE + re-add as `ON DELETE SET NULL`
-- (matching the committed schema). The re-add uses `NOT VALID` + a separate
-- `VALIDATE CONSTRAINT` so the AccessExclusive lock is held for milliseconds,
-- not the time it takes to scan the `things` table — avoiding the QUA-302 /
-- QUA-156 outage pattern where a long DDL deadlocked with the `things_search`
-- MV refresh.
--
-- The `things_search` MV refresh runs outside the main transaction (after
-- `COMMIT`) so the SELECT locks the refresh acquires on every base table do
-- not compound with any other DDL contention.

BEGIN;

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '0';

-- ---------------------------------------------------------------------------
-- 1. Pre-conditions.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  null_count int;
  bare10_count int;
  test_row_count int;
BEGIN
  SELECT count(*) INTO null_count FROM resources WHERE stable_id IS NULL;

  SELECT count(*) INTO bare10_count
  FROM resources
  WHERE stable_id ~ '^[A-Za-z0-9]{10}$' AND stable_id !~ '^sid_';

  SELECT count(*) INTO test_row_count
  FROM resources
  WHERE id = 'test-resource-probe';

  IF null_count = 0 THEN
    RAISE EXCEPTION 'QUA-536: no NULL resources.stable_id rows — migration already applied, or pre-flight snapshot is stale. Aborting to avoid silent no-op.';
  END IF;

  IF bare10_count > 0 THEN
    RAISE EXCEPTION 'QUA-536: % bare10 rows reappeared in resources.stable_id — QUA-503 cleared these. Investigate before proceeding.',
      bare10_count;
  END IF;

  RAISE NOTICE 'QUA-536: pre-conditions OK — % NULL rows to populate; test-probe row present: %',
    null_count, (test_row_count > 0);
END $$;

-- ---------------------------------------------------------------------------
-- 2. Delete the test-probe row (and its `things` row, if any).
--    The row (`id='test-resource-probe'`, `stable_id='probe-test-001'`) was
--    left over from an earlier manual test and has a non-canonical stable_id
--    format. It would fail the post-condition format check if left in place,
--    and it would also fail QUA-492's eventual CHECK constraint.
-- ---------------------------------------------------------------------------

DELETE FROM things
WHERE source_table = 'resources' AND source_id = 'test-resource-probe';

DELETE FROM resources
WHERE id = 'test-resource-probe' AND stable_id = 'probe-test-001';

-- ---------------------------------------------------------------------------
-- 3. Drop FKs on `things.id` so the PK UPDATE in step 5 can proceed.
--
--    Discovered dynamically via `pg_constraint` (same pattern as migration
--    0182). Recorded in a temp table so step 6 can re-add them symmetrically.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE qua536_dropped_fks (
  table_name text NOT NULL,
  constraint_name text NOT NULL,
  fk_column text NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT
      t.relname AS table_name,
      c.conname AS constraint_name,
      a.attname AS fk_column
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
     AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'things'::regclass
      AND array_length(c.conkey, 1) = 1
  LOOP
    INSERT INTO qua536_dropped_fks (table_name, constraint_name, fk_column)
    VALUES (rec.table_name, rec.constraint_name, rec.fk_column);
    RAISE NOTICE 'QUA-536: dropping FK %.% (% -> things.id)',
      rec.table_name, rec.constraint_name, rec.fk_column;
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT %I',
      rec.table_name,
      rec.constraint_name
    );
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM qua536_dropped_fks) THEN
    RAISE EXCEPTION 'QUA-536: expected at least one FK referencing things.id but found none — schema drift?';
  END IF;
END $$;

-- Assert the dropped set matches what step 5/6 know how to handle. Any new FK
-- on `things.id` would need its own UPDATE in step 5 below, so fire loudly if
-- one appears.
DO $$
DECLARE
  unexpected int;
BEGIN
  SELECT count(*) INTO unexpected
  FROM qua536_dropped_fks
  WHERE (table_name, fk_column) NOT IN (
    ('things',         'parent_thing_id'),
    ('qa_page_checks', 'thing_id')
  );
  IF unexpected > 0 THEN
    RAISE EXCEPTION
      'QUA-536: % unexpected FK column(s) reference things.id; add UPDATEs for them in step 5 and update this assertion',
      unexpected;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Populate NULL `resources.stable_id` with `sid_` + 10 random alphanumeric
--    characters. Alphabet matches the TS `generateId()` in
--    `packages/factbase/src/ids.ts:45` (A-Z, a-z, 0-9 — 62 chars).
--
--    The generator is a VOLATILE PL/pgSQL function so that `UPDATE` evaluates
--    it once per row. A naive scalar subquery in SET would be folded to a
--    single value by the planner and assign every row the same id.
--
--    Collision handling: with 62^10 ≈ 8.4×10^17 possibilities and ~22,893
--    total resource rows after this migration, birthday-paradox collision
--    probability is ~10^-10. We still wrap the UPDATE in an EXCEPTION /
--    retry loop so a spurious collision re-generates affected rows rather
--    than aborting the whole transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.qua536_sid_gen() RETURNS text AS $$
DECLARE
  alphabet text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  result text := '';
  i int;
BEGIN
  FOR i IN 1..10 LOOP
    result := result || substr(alphabet, 1 + floor(random() * 62)::int, 1);
  END LOOP;
  RETURN 'sid_' || result;
END;
$$ LANGUAGE plpgsql VOLATILE;

DO $$
DECLARE
  attempt int := 0;
  max_attempts int := 5;
  remaining int;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      UPDATE resources
      SET stable_id = pg_temp.qua536_sid_gen()
      WHERE stable_id IS NULL;

      SELECT count(*) INTO remaining FROM resources WHERE stable_id IS NULL;
      IF remaining = 0 THEN
        RAISE NOTICE 'QUA-536: populated stable_ids in % attempt(s)', attempt;
        EXIT;
      END IF;
      RAISE EXCEPTION 'QUA-536: UPDATE succeeded but % NULL rows remain — concurrent writer?',
        remaining;
    EXCEPTION WHEN unique_violation THEN
      IF attempt >= max_attempts THEN
        RAISE EXCEPTION 'QUA-536: exceeded % attempts due to stable_id unique_violation — collision rate far higher than expected',
          max_attempts;
      END IF;
      RAISE NOTICE 'QUA-536: unique_violation on attempt %, retrying', attempt;
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Align `things` rows to the canonical stable_id.
--
--    Two kinds of stale rows get corrected here:
--    (a) rows for resources that were just populated in step 4 (~17,482)
--    (b) pre-existing stale rows (~4,769) where resources.stable_id was
--        already populated but things.id was never re-synced after QUA-503.
--
--    Per pre-flight, `parent_thing_id` self-refs and `qa_page_checks.thing_id`
--    have ZERO rows pointing at resource things today — the UPDATEs below are
--    defensive: they fire only if rows appear between pre-flight and apply.
--    Including them means a schema drift or a concurrent insert cannot leave
--    a dangling reference after this migration.
-- ---------------------------------------------------------------------------

UPDATE things t
   SET id = r.stable_id,
       updated_at = now(),
       synced_at  = now()
  FROM resources r
 WHERE t.source_table = 'resources'
   AND t.source_id = r.id
   AND t.id <> r.stable_id;

UPDATE things t
   SET parent_thing_id = r.stable_id
  FROM resources r
 WHERE t.parent_thing_id = r.id;

UPDATE qa_page_checks q
   SET thing_id = r.stable_id
  FROM resources r
 WHERE q.thing_id = r.id;

-- ---------------------------------------------------------------------------
-- 6. Re-add FKs in NOT VALID mode, matching the original ON DELETE SET NULL
--    semantics. Static DDL because the assertion in step 3 guarantees the
--    dropped set matches these two (table, column) pairs and both are
--    `ON DELETE SET NULL` in the committed schema. VALIDATE CONSTRAINT runs
--    outside the transaction (step 9) under SHARE UPDATE EXCLUSIVE so
--    concurrent reads/writes against `things` proceed normally.
--
--    Constraint names use the Drizzle convention (`*_things_id_fk`) so future
--    `drizzle-kit generate` runs don't emit spurious renames.
-- ---------------------------------------------------------------------------

ALTER TABLE things
  ADD CONSTRAINT things_parent_thing_id_things_id_fk
  FOREIGN KEY (parent_thing_id) REFERENCES things(id) ON DELETE SET NULL
  NOT VALID;

ALTER TABLE qa_page_checks
  ADD CONSTRAINT qa_page_checks_thing_id_things_id_fk
  FOREIGN KEY (thing_id) REFERENCES things(id) ON DELETE SET NULL
  NOT VALID;

-- ---------------------------------------------------------------------------
-- 7. Post-condition checks.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  remaining_null int;
  bad_format int;
  dup_count int;
  stale_things int;
BEGIN
  SELECT count(*) INTO remaining_null FROM resources WHERE stable_id IS NULL;
  IF remaining_null <> 0 THEN
    RAISE EXCEPTION 'QUA-536: % NULL resources.stable_id rows remain after step 4', remaining_null;
  END IF;

  SELECT count(*) INTO bad_format
  FROM resources
  WHERE stable_id !~ '^sid_[A-Za-z0-9]{10}$';
  IF bad_format <> 0 THEN
    RAISE EXCEPTION 'QUA-536: % rows have non-canonical stable_id format after step 4',
      bad_format;
  END IF;

  SELECT count(*) INTO dup_count
  FROM (
    SELECT stable_id FROM resources
    GROUP BY stable_id HAVING count(*) > 1
  ) d;
  IF dup_count <> 0 THEN
    RAISE EXCEPTION 'QUA-536: % duplicate stable_id values after step 4', dup_count;
  END IF;

  SELECT count(*) INTO stale_things
  FROM things t
  JOIN resources r ON r.id = t.source_id
  WHERE t.source_table = 'resources' AND t.id <> r.stable_id;
  IF stale_things <> 0 THEN
    RAISE EXCEPTION 'QUA-536: % things rows still mismatch resources.stable_id after step 5',
      stale_things;
  END IF;

  RAISE NOTICE 'QUA-536: post-condition checks passed';
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- 8. Validate the FKs we re-added in NOT VALID mode. Runs OUTSIDE the main
--    transaction under SHARE UPDATE EXCLUSIVE so concurrent reads and writes
--    against `things` proceed normally during the validation scan.
-- ---------------------------------------------------------------------------

ALTER TABLE things VALIDATE CONSTRAINT things_parent_thing_id_things_id_fk;
ALTER TABLE qa_page_checks VALIDATE CONSTRAINT qa_page_checks_thing_id_things_id_fk;

-- ---------------------------------------------------------------------------
-- 9. Add NOT NULL constraint on resources.stable_id.
--
--    DONE OUTSIDE the main transaction. Inside the main transaction it would
--    deadlock with a concurrent reader/writer on `resources` — the UPDATE in
--    step 4 acquires row locks, a concurrent UPDATE/DELETE on one of those
--    rows would then wait on our xact, and a subsequent `SET NOT NULL` in our
--    xact (wanting AccessExclusiveLock) would circular-block on that waiter.
--
--    By splitting AFTER COMMIT, the row locks from step 4 are released first;
--    `SET NOT NULL` then only contends with live readers/writers briefly.
--    The explicit `lock_timeout` + retry loop bounds any contention: each
--    attempt gives up after 5s and retries with 1s backoff, so a short-lived
--    concurrent reader does not abort the whole migration.
--
--    PG ≥ 12: scan cost is catalog-only when no explicit CHECK exists, but PG
--    still needs AccessExclusive briefly. 22,893 rows is fast.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  attempt int := 0;
  max_attempts int := 10;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      SET LOCAL lock_timeout = '5s';
      ALTER TABLE resources ALTER COLUMN stable_id SET NOT NULL;
      RAISE NOTICE 'QUA-536: SET NOT NULL on resources.stable_id succeeded in attempt %', attempt;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= max_attempts THEN
        RAISE EXCEPTION 'QUA-536: SET NOT NULL on resources.stable_id could not acquire AccessExclusiveLock after % attempts — retry during a low-traffic window',
          max_attempts;
      END IF;
      RAISE NOTICE 'QUA-536: lock_timeout on attempt %, retrying in 1s', attempt;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Refresh the `things_search` materialized view so search stays in sync.
--     Outside the main transaction so the SELECT locks the refresh acquires
--     on every base table do not compound with any other DDL contention.
--     REFRESH MATERIALIZED VIEW CONCURRENTLY requires a UNIQUE INDEX on the
--     MV (created by migration 0181).
-- ---------------------------------------------------------------------------

REFRESH MATERIALIZED VIEW CONCURRENTLY things_search;

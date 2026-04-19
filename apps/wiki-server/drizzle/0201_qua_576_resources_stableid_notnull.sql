-- QUA-576: reconcile schema.ts with DB state on resources.stable_id.
--
-- Migration 0184 (QUA-536 Phase A) already set `resources.stable_id` NOT NULL
-- in prod via the out-of-band script at
-- apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql. The
-- drizzle snapshot never caught up because 0184 itself is a `SELECT 1;`
-- no-op on the Drizzle side.
--
-- schema.ts has now been updated to `.notNull().unique()` to match DB
-- reality. This migration is a belt-and-suspenders idempotent SET NOT NULL
-- so any environment where 0184's script was skipped (e.g., a freshly
-- bootstrapped dev DB that applied 0184 as a no-op) converges to the
-- correct state.
--
-- Guard: abort if any NULL rows still exist. If this fires, the 0184 script
-- was not run (or failed); do not silently erase the discrepancy.
DO $$
DECLARE
  null_count bigint;
BEGIN
  SELECT COUNT(*) INTO null_count FROM resources WHERE stable_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION
      'QUA-576: % resources rows have NULL stable_id. Run apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql before applying this migration.',
      null_count;
  END IF;
END $$;

-- Idempotent on prod (already NOT NULL from 0184); applies the constraint
-- on any environment that somehow lacks it.
ALTER TABLE "resources" ALTER COLUMN "stable_id" SET NOT NULL;

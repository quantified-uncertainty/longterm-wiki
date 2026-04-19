-- QUA-576: reconcile schema.ts with prod DB state on resources.stable_id.
--
-- Migration 0184 (QUA-536 Phase A) set NOT NULL in prod via an out-of-band
-- psql script. Drizzle never caught up because 0184 itself is SELECT 1.
-- Idempotent on prod; catches up any dev DB that skipped the 0184 script.
-- Aborts loudly if NULL rows still exist so the discrepancy is not masked.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM resources WHERE stable_id IS NULL) THEN
    RAISE EXCEPTION
      'QUA-576: resources rows with NULL stable_id exist. Run apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql first.';
  END IF;

  IF (
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'resources'
      AND column_name = 'stable_id'
  ) = 'YES' THEN
    ALTER TABLE "resources" ALTER COLUMN "stable_id" SET NOT NULL;
  END IF;
END $$;

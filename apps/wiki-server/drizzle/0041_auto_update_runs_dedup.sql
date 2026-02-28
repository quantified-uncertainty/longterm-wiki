-- Migration 0020: Deduplicate auto_update_runs and add unique constraint on started_at
--
-- Background: The sync-auto-update-runs command used plain INSERT without upsert logic,
-- causing many duplicate rows when the sync-data workflow ran on each push. This
-- migration removes duplicates (keeping the latest row per started_at) and adds a
-- unique constraint to prevent future duplicates.
--
-- auto_update_results will be cleaned up automatically via ON DELETE CASCADE.

-- Step 1: Delete duplicate auto_update_runs (keep the one with the highest id per started_at)
DELETE FROM auto_update_runs
WHERE id IN (
  SELECT r.id FROM auto_update_runs r
  WHERE EXISTS (
    SELECT 1 FROM auto_update_runs r2
    WHERE r2.started_at = r.started_at AND r2.id > r.id
  )
);
--> statement-breakpoint

-- Step 2: Drop the old non-unique index (replaced by the unique index below)
DROP INDEX IF EXISTS "idx_aur_started_at";
--> statement-breakpoint

-- Step 3: Add unique constraint on started_at (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_aur_started_at_unique" ON "auto_update_runs" ("started_at");

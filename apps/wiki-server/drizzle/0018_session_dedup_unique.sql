-- Migration 0018: Deduplicate sessions and add unique constraint on (date, title)
--
-- Background: The sessions batch endpoint used plain INSERT without upsert logic,
-- causing ~165 duplicate rows when re-syncing. This migration removes duplicates
-- (keeping the latest row per date+title combo) and adds a unique constraint to
-- prevent future duplicates.

-- Step 1: Delete duplicate sessions (keep the one with the highest id per date+title)
DELETE FROM session_pages
WHERE session_id IN (
  SELECT s.id FROM sessions s
  WHERE EXISTS (
    SELECT 1 FROM sessions s2
    WHERE s2.date = s.date AND s2.title = s.title AND s2.id > s.id
  )
);
--> statement-breakpoint

DELETE FROM sessions
WHERE id IN (
  SELECT s.id FROM sessions s
  WHERE EXISTS (
    SELECT 1 FROM sessions s2
    WHERE s2.date = s.date AND s2.title = s.title AND s2.id > s.id
  )
);
--> statement-breakpoint

-- Step 2: Add unique constraint (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_sess_date_title" ON "sessions" ("date", "title");

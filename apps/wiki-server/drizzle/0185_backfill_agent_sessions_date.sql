-- Backfill `agent_sessions.date` from `started_at` for rows where it's null.
--
-- Context: `date` is supposed to be populated by `crux sys session-finalize`
-- (async SessionEnd hook), but the hook is unreliable — it runs async with a
-- 30s timeout and fails silently. The groundskeeper sweep then marks those
-- sessions `completed` without touching `date`, so rows end up with
-- status=completed, date=null, and drop out of every date-filtered query
-- (retrospective, /internal/page-changes).
--
-- This UPDATE is idempotent and bounded (only a few hundred rows in prod).
UPDATE agent_sessions
   SET date = started_at::date
 WHERE date IS NULL;

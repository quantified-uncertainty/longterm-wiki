-- QUA-584: One-shot backfill for phantom active_agents rows.
--
-- Investigation 2026-04-17 found 77/81 status='active' rows had heartbeats
-- older than 30 minutes (many >7 days), because /agent-ship never closed
-- the active_agents row and no scheduled sweep existed for this table.
--
-- This script:
--   1. Marks phantom 'active' rows stale and sets completed_at to the last
--      known sign of life (heartbeat_at), matching the behavior the new
--      sweep endpoint applies going forward.
--   2. Backfills completed_at on any historically-swept rows (status in
--      stale/completed/errored) where completed_at is NULL — pre-PR the
--      sweep endpoint never set this column, so older rows would leave
--      session duration uncomputable in dashboards.
--
-- Idempotent: the WHERE clauses filter on either status='active' or
-- completed_at IS NULL, so re-running is a no-op. Safe to apply via psql.
--
-- Apply with:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/qua-584-backfill-active-agents-stale.sql

-- Step 1: flip phantom 'active' rows to stale with completed_at = heartbeat_at.
UPDATE active_agents
SET status      = 'stale',
    completed_at = heartbeat_at,
    updated_at   = NOW()
WHERE status     = 'active'
  AND heartbeat_at < NOW() - INTERVAL '30 minutes';

-- Step 2: backfill completed_at on historically-swept rows that pre-date
-- this PR (sweep used to not populate completed_at at all).
UPDATE active_agents
SET completed_at = heartbeat_at,
    updated_at   = NOW()
WHERE status IN ('stale', 'completed', 'errored')
  AND completed_at IS NULL;

-- Verify (optional — comment out for non-interactive runs):
SELECT
  COUNT(*) FILTER (WHERE status = 'active')  AS still_active,
  COUNT(*) FILTER (WHERE status = 'stale')   AS now_stale,
  COUNT(*) FILTER (WHERE completed_at IS NULL AND status <> 'active') AS missing_completed_at
FROM active_agents;

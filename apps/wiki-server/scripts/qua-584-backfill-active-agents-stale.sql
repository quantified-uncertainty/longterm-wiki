-- QUA-584: One-shot backfill for phantom active_agents rows.
--
-- Investigation 2026-04-17 found 77/81 status='active' rows had heartbeats
-- older than 60 minutes (many >7 days), because /agent-ship never closed
-- the active_agents row and no scheduled sweep existed for this table.
--
-- This script marks those phantoms stale and sets completed_at to the last
-- known sign of life (heartbeat_at), matching the behavior the new sweep
-- endpoint applies going forward.
--
-- Idempotent: re-running on already-stale rows is a no-op (WHERE filters
-- on status='active'). Safe to apply via psql against prod.
--
-- Apply with:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/qua-584-backfill-active-agents-stale.sql

UPDATE active_agents
SET status      = 'stale',
    completed_at = heartbeat_at,
    updated_at   = NOW()
WHERE status     = 'active'
  AND heartbeat_at < NOW() - INTERVAL '60 minutes';

-- Verify (optional — comment out for non-interactive runs):
SELECT
  COUNT(*) FILTER (WHERE status = 'active')  AS still_active,
  COUNT(*) FILTER (WHERE status = 'stale')   AS now_stale,
  COUNT(*) FILTER (WHERE completed_at IS NULL AND status <> 'active') AS missing_completed_at
FROM active_agents;

-- QUA-445 Phase B: add heartbeat_at to agent_sessions.
--
-- Sets up agent_sessions to replace active_agents as the liveness source
-- of truth. The heartbeat hook will populate BOTH active_agents.heartbeat_at
-- AND agent_sessions.heartbeat_at during the transition (QUA-440 started
-- this on updated_at; this migration adds a dedicated column so updated_at
-- can go back to its normal meaning of "row last touched for any reason"
-- instead of "liveness signal").
--
-- When active_agents is dropped in QUA-445 Phase E, this column becomes
-- the only heartbeat record and powers the dashboard's "last heartbeat
-- Nm ago" cell.
--
-- Lock profile (same pattern as migration 0178):
--   ADD COLUMN  → ACCESS EXCLUSIVE, milliseconds, no rewrite (nullable
--                 timestamptz, no default)
--   CREATE INDEX (partial on non-null heartbeat_at for status='active')
--               → SHARE briefly; index is empty at migration time
--
-- No backfill: existing rows stay NULL. The dedup query already uses
-- updated_at with a 30-min window, so nothing breaks. After this migration
-- lands, new heartbeats populate heartbeat_at; a follow-up phase will
-- switch dedup/dashboard to prefer heartbeat_at when non-null, falling
-- back to updated_at for pre-QUA-445 rows.

ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamptz;

-- Partial index scoped to active sessions with a heartbeat. The dedup
-- query filters on status + heartbeat freshness, so this is the exact
-- access pattern. Small index: only active rows, usually <50 on prod.
CREATE INDEX IF NOT EXISTS "idx_as_heartbeat_at_active"
  ON "agent_sessions" ("heartbeat_at")
  WHERE "heartbeat_at" IS NOT NULL AND "status" = 'active';

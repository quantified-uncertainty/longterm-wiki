-- Add session_id FK to agent_sessions, linking live tracking records to their
-- corresponding historical session log.
--
-- This replaces the fragile branch-name join currently used by the Agent Sessions
-- dashboard to enrich agent_sessions with cost/model data from the sessions table.
-- With this FK, the dashboard can use a direct JOIN instead of a heuristic match.
--
-- The column is nullable because:
-- 1. Older records predate this migration and won't have a session_id
-- 2. Some agent sessions may never produce a session log (e.g., abandoned sessions)
-- 3. Session logs can be created after agent sessions (at PR time)
--
-- Note: adding-foreign-key-constraint is excluded in .squawk.toml because Drizzle's
-- migrator runs in a single transaction, making the two-step NOT VALID / VALIDATE
-- pattern impossible. agent_sessions is a small table (hundreds of rows), so the
-- brief SHARE ROW EXCLUSIVE lock is acceptable.

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "session_id" integer REFERENCES "sessions"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_as_session_id" ON "agent_sessions" ("session_id");

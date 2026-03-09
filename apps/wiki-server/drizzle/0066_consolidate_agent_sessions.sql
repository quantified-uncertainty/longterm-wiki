-- Consolidate session tracking: agent_sessions becomes the single source of truth
-- for the full agent checklist session lifecycle (issue #1668).
--
-- Changes:
-- 1. Add session log fields to agent_sessions (previously only in sessions table)
-- 2. Add agent_session_pages junction table (replaces session_pages for agent sessions)
-- 3. Remove session_id FK from agent_sessions (no longer needed — data is written directly)

-- 1. Add session log fields to agent_sessions
ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "date" date,
  ADD COLUMN IF NOT EXISTS "title" text,
  ADD COLUMN IF NOT EXISTS "summary" text,
  ADD COLUMN IF NOT EXISTS "model" text,
  ADD COLUMN IF NOT EXISTS "duration" text,
  ADD COLUMN IF NOT EXISTS "duration_minutes" real,
  ADD COLUMN IF NOT EXISTS "cost" text,
  ADD COLUMN IF NOT EXISTS "cost_cents" integer,
  ADD COLUMN IF NOT EXISTS "checks_yaml" text,
  ADD COLUMN IF NOT EXISTS "issues_json" jsonb,
  ADD COLUMN IF NOT EXISTS "learnings_json" jsonb,
  ADD COLUMN IF NOT EXISTS "recommendations_json" jsonb,
  ADD COLUMN IF NOT EXISTS "reviewed" boolean;

-- 2. Add agent_session_pages junction table
CREATE TABLE IF NOT EXISTS "agent_session_pages" (
  "agent_session_id" bigint NOT NULL REFERENCES "agent_sessions"("id") ON DELETE CASCADE,
  "page_id" text NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "page_id_int" integer REFERENCES "wiki_pages"("integer_id_col"),
  PRIMARY KEY ("agent_session_id", "page_id")
);

CREATE INDEX IF NOT EXISTS "idx_asp_page_id" ON "agent_session_pages" ("page_id");
CREATE INDEX IF NOT EXISTS "idx_asp_page_id_int" ON "agent_session_pages" ("page_id_int");
CREATE INDEX IF NOT EXISTS "idx_asp_agent_session_id" ON "agent_session_pages" ("agent_session_id");

-- 3. Remove session_id FK — agent_sessions no longer references sessions table
DROP INDEX IF EXISTS "idx_as_session_id";
ALTER TABLE "agent_sessions" DROP COLUMN IF EXISTS "session_id";

-- Add human-friendly session names to active_agents and create
-- agent_session_events table for activity timeline tracking.

-- Phase 1: Session naming — add session_name column to active_agents
ALTER TABLE "active_agents" ADD COLUMN IF NOT EXISTS "session_name" text;

-- Phase 2: Activity log — create agent_session_events table
CREATE TABLE IF NOT EXISTS "agent_session_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "agent_id" bigint NOT NULL,
  "event_type" text NOT NULL,
  "message" text NOT NULL,
  "metadata" jsonb,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_ase_agent_id" ON "agent_session_events" USING btree ("agent_id");
CREATE INDEX IF NOT EXISTS "idx_ase_event_type" ON "agent_session_events" USING btree ("event_type");
CREATE INDEX IF NOT EXISTS "idx_ase_timestamp" ON "agent_session_events" USING btree ("timestamp");

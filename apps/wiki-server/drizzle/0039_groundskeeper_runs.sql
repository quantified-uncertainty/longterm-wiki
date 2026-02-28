-- Groundskeeper runs table for tracking scheduled task executions.
-- Replaces the local JSON run log with a server-side store so dashboards
-- can visualize task history, uptime, and circuit breaker events.

CREATE TABLE IF NOT EXISTS "groundskeeper_runs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "task_name" text NOT NULL,
  "event" text NOT NULL,
  "success" boolean NOT NULL,
  "duration_ms" integer,
  "summary" text,
  "error_message" text,
  "consecutive_failures" integer,
  "circuit_breaker_active" boolean DEFAULT false NOT NULL,
  "metadata" jsonb,
  "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_gkr_task_name" ON "groundskeeper_runs" USING btree ("task_name");
CREATE INDEX IF NOT EXISTS "idx_gkr_event" ON "groundskeeper_runs" USING btree ("event");
CREATE INDEX IF NOT EXISTS "idx_gkr_timestamp" ON "groundskeeper_runs" USING btree ("timestamp");
CREATE INDEX IF NOT EXISTS "idx_gkr_task_timestamp" ON "groundskeeper_runs" USING btree ("task_name", "timestamp");

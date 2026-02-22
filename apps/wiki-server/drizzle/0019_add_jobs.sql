CREATE TABLE IF NOT EXISTS "jobs" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "params" jsonb,
  "result" jsonb,
  "error" text,
  "priority" integer NOT NULL DEFAULT 0,
  "retries" integer NOT NULL DEFAULT 0,
  "max_retries" integer NOT NULL DEFAULT 3,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "claimed_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "worker_id" text
);

CREATE INDEX IF NOT EXISTS "idx_jobs_status_priority" ON "jobs" ("status", "priority");
CREATE INDEX IF NOT EXISTS "idx_jobs_type_status" ON "jobs" ("type", "status");
CREATE INDEX IF NOT EXISTS "idx_jobs_created_at" ON "jobs" ("created_at");

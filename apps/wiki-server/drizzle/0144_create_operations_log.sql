CREATE TABLE IF NOT EXISTS "operations_log" (
  "id" bigserial PRIMARY KEY,
  "description" text NOT NULL,
  "pr_number" integer,
  "agent_session_id" bigint REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
  "operator" text NOT NULL DEFAULT 'agent',
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ops_log_created" ON "operations_log" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_ops_log_pr" ON "operations_log" ("pr_number");
CREATE INDEX IF NOT EXISTS "idx_ops_log_session" ON "operations_log" ("agent_session_id");

-- Active agents table for live agent coordination.
-- Tracks currently-running Claude Code agents so they can detect
-- conflicts (same issue, overlapping files) and avoid duplicate work.

CREATE TABLE IF NOT EXISTS "active_agents" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "branch" text,
  "task" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "current_step" text,
  "issue_number" integer,
  "pr_number" integer,
  "files_touched" jsonb,
  "model" text,
  "worktree" text,
  "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "active_agents_session_id_unique" UNIQUE("session_id")
);

CREATE INDEX IF NOT EXISTS "idx_aa_status" ON "active_agents" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_aa_issue" ON "active_agents" USING btree ("issue_number");
CREATE INDEX IF NOT EXISTS "idx_aa_heartbeat" ON "active_agents" USING btree ("heartbeat_at");
CREATE INDEX IF NOT EXISTS "idx_aa_started_at" ON "active_agents" USING btree ("started_at");
CREATE INDEX IF NOT EXISTS "idx_aa_branch" ON "active_agents" USING btree ("branch");

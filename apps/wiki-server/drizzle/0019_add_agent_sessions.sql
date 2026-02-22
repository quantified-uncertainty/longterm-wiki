-- Agent sessions — tracks active Claude Code sessions and their checklist state.
-- Used by `crux agent-checklist` commands to persist checklist state to the DB
-- so it survives across sessions and doesn't need to be committed to git.

CREATE TABLE "agent_sessions" (
  "id" bigserial PRIMARY KEY,
  "branch" text NOT NULL,
  "task" text NOT NULL,
  "session_type" text NOT NULL,
  "issue_number" integer,
  "checklist_md" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_as_branch" ON "agent_sessions" ("branch");
CREATE INDEX "idx_as_status" ON "agent_sessions" ("status");
CREATE INDEX "idx_as_issue" ON "agent_sessions" ("issue_number");
CREATE INDEX "idx_as_started_at" ON "agent_sessions" ("started_at");

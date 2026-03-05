-- Add pr_url column to agent_sessions to capture the PR URL when crux issues done --pr=URL is called.
-- Previously, prUrl was only available on the sessions table (session logs), requiring a join on branch.
-- Storing it directly on agent_sessions makes it available immediately at session end.

ALTER TABLE "agent_sessions" ADD COLUMN "pr_url" text;

-- Add pr_outcome column to agent_sessions table.
-- Records whether a PR was merged, merged with revisions, reverted, or closed without merge.
-- This enables outcome-based analysis of agent sessions.

ALTER TABLE "agent_sessions" ADD COLUMN "pr_outcome" text;

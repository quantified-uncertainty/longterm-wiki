-- Add worktree column to agent_sessions table to track the working directory
-- of each agent session. This enables collision detection (multiple agents in
-- same directory) and better visibility on the Agent Sessions dashboard (E912).
ALTER TABLE "agent_sessions" ADD COLUMN "worktree" text;

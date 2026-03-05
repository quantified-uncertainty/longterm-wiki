-- Add pr_outcome column to agent_sessions to track what happened to the PR after session completion.
-- Valid values: 'merged', 'merged_with_revisions', 'reverted', 'closed_without_merge'.
-- NULL means the outcome has not been recorded yet (common for in-progress or recent sessions).
-- Set via: crux issues done <N> --outcome=merged

ALTER TABLE "agent_sessions" ADD COLUMN "pr_outcome" text;

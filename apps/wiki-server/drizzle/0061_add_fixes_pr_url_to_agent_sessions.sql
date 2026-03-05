-- Add fixes_pr_url column to agent_sessions to track fix-chain relationships.
-- When a session is fixing issues introduced by a previous PR, this field
-- stores the URL of the PR being fixed. Enables fix rate computation:
--   fix_rate = COUNT(*) FILTER (WHERE fixes_pr_url IS NOT NULL) / COUNT(*)
-- Set via: crux issues done <N> --pr=URL --fixes-pr=PREV_URL

ALTER TABLE "agent_sessions" ADD COLUMN "fixes_pr_url" text;

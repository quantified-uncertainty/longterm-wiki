-- Add reviewed column to sessions table.
-- Tracks whether /review-pr was run during the session that produced this log entry.
-- NULL means unknown (pre-feature sessions), TRUE means reviewed, FALSE means not reviewed.

ALTER TABLE sessions ADD COLUMN reviewed BOOLEAN;

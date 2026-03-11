-- Add stable_id column to resources table.
-- 10-char alphanumeric IDs matching the KB entity ID format.
-- Existing rows will be backfilled via a manual script after deploy.
ALTER TABLE resources ADD COLUMN stable_id TEXT UNIQUE;
CREATE INDEX idx_res_stable_id ON resources (stable_id) WHERE stable_id IS NOT NULL;

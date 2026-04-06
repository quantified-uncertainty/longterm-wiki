-- Drop the legacy sources JSONB column from entities table.
-- Entity sources have been removed from YAML and all frontend consumers.
ALTER TABLE entities DROP COLUMN IF EXISTS sources;

-- Add stance column to resources for legislation coverage classification.
-- Values: support, oppose, neutral, mixed, analysis (or NULL for unclassified).
ALTER TABLE resources ADD COLUMN IF NOT EXISTS stance TEXT;

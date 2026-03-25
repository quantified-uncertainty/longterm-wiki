-- Deduplicate source_check_evidence table.
-- Add a unique constraint on (record_type, record_id, source_url, checker_model)
-- so re-running a source-check with the same model against the same URL updates
-- the existing row instead of creating duplicates.
--
-- Before adding the constraint, remove existing duplicates by keeping the most recent row.
-- This is safe because duplicate rows carry nearly identical data (the latest is most accurate).

-- Step 1: Remove duplicates (keep the row with the highest id = most recent insert)
DELETE FROM source_check_evidence
WHERE id NOT IN (
  SELECT MAX(id)
  FROM source_check_evidence
  GROUP BY record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, '')
);

-- Step 2: Add unique index for deduplication
-- Uses COALESCE to handle NULLs (NULL source_url or checker_model treated as empty string)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sce_dedup
  ON source_check_evidence (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''));

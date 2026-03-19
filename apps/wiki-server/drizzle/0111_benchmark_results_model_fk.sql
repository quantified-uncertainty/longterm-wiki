-- Add FK constraint on benchmark_results.model_id -> entities.id (slug).
--
-- benchmark_results.model_id stores entity slugs (e.g., "gpt-4o", "claude-3-5-sonnet").
-- entities.id has a UNIQUE constraint, so it's a valid FK target.
--
-- Step 1: Delete orphan benchmark_results whose model_id doesn't exist in entities.
-- Step 2: Add the FK constraint with ON DELETE CASCADE.
--
-- Both tables are small (<500 rows) -- runs in milliseconds.

-- Step 1: Clean up orphan benchmark_results
DELETE FROM benchmark_results
WHERE model_id NOT IN (SELECT id FROM entities);

-- Step 2: Add FK constraint
ALTER TABLE benchmark_results
  ADD CONSTRAINT benchmark_results_model_id_entities_id_fk
  FOREIGN KEY (model_id)
  REFERENCES entities(id)
  ON DELETE CASCADE;

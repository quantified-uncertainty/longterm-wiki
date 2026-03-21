-- Add foreign key constraint on benchmark_results.model_id → entities.stable_id
-- This strengthens referential integrity for AI model references in benchmark scores.
-- Safe: benchmark_results is a small table (<10K rows).
--
-- First, delete any benchmark_results rows where model_id doesn't match an entity.
-- This prevents the FK constraint from failing on orphaned references.
DELETE FROM benchmark_results
  WHERE model_id IS NOT NULL
    AND model_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);

-- Now add the FK constraint. Uses NOT VALID + VALIDATE to avoid full table lock
-- during the constraint check (though the table is small enough it doesn't matter much).
ALTER TABLE benchmark_results
  ADD CONSTRAINT fk_benchmark_results_model
  FOREIGN KEY (model_id) REFERENCES entities(stable_id) ON DELETE CASCADE;

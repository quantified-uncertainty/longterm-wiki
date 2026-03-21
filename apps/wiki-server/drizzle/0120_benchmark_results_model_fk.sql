-- Add foreign key constraint on benchmark_results.model_id → entities.stable_id
-- This strengthens referential integrity for AI model references in benchmark scores.
-- Safe: benchmark_results is a small table (<10K rows).
-- Uses CASCADE because a benchmark result without its model entity is meaningless.
ALTER TABLE benchmark_results
  ADD CONSTRAINT fk_benchmark_results_model
  FOREIGN KEY (model_id) REFERENCES entities(stable_id) ON DELETE CASCADE;

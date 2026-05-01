-- QUA-1012 (parent QUA-1011): pipeline_runs cost telemetry columns.
--
-- Adds nullable cost / token-count columns so pipelines can attribute
-- their LLM spend to a run on the /internal/pipeline-runs dashboard.
-- All five columns are nullable: existing rows have no telemetry, and
-- pipelines that don't track cost (or fail before they can attribute)
-- continue to land NULL. Subsequent QUA-1011 children (#2 = wire the
-- improve pipeline, #3 = wire the source-check pipeline) start
-- populating these.
--
-- - `cost_usd numeric(10,4)` — dollars-and-tenths-of-a-cent precision.
--   Wide enough for a single $999,999.9999 run; aggregating across runs
--   uses SUM() into a wider numeric in the dashboard query.
-- - `tokens_*` are integer (signed 32-bit, max ~2.1B). Single-run token
--   counts are far below that ceiling — Anthropic's 200k context cap
--   bounds a single call's input tokens, and even a long multi-call
--   pipeline lands well under 1B total. bigint would be overkill.
-- - All columns are NULL-default; no backfill needed (no caller writes
--   them yet — they start populating in QUA-1011 children).
-- - Pipeline_runs table just shipped in 0222 (QUA-954). Row count is
--   small / zero on most environments, so plain ADD COLUMN is fine —
--   no NOT VALID dance, no batched UPDATE.
-- - Audit trigger from 0222 (apply_audit_trigger) automatically picks
--   up the new columns; per-row UPDATE writes already capture them in
--   `full_audit_log`.

ALTER TABLE "pipeline_runs"
  ADD COLUMN IF NOT EXISTS "cost_usd"            numeric(10,4),
  ADD COLUMN IF NOT EXISTS "tokens_input"        integer,
  ADD COLUMN IF NOT EXISTS "tokens_output"       integer,
  ADD COLUMN IF NOT EXISTS "tokens_cache_read"   integer,
  ADD COLUMN IF NOT EXISTS "tokens_cache_write"  integer;

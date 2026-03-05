-- Add numeric cost_cents and duration_minutes columns to the sessions table.
-- These are parsed from the free-text cost/duration strings (e.g. "~$0.50" → 50, "~20 minutes" → 20.0)
-- and enable aggregation, trend analysis, and spend alerting.
-- The original text fields are kept for backwards compatibility.

ALTER TABLE "sessions" ADD COLUMN "cost_cents" integer;
ALTER TABLE "sessions" ADD COLUMN "duration_minutes" real;

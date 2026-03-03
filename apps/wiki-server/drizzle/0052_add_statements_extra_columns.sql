-- Add columns from discussion #1540 that were not in the initial schema:
-- properties.description, statements.statement_text, statements.value_unit,
-- statements.temporal_granularity, statements.archive_reason

ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "description" TEXT;

ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "statement_text" TEXT;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "value_unit" TEXT;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "temporal_granularity" TEXT;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "archive_reason" TEXT;

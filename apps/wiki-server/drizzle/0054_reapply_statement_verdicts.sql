-- Re-apply verdict/verification columns.
-- Migration 0052 was recorded in __drizzle_migrations but the DDL did not
-- execute on the production database (likely due to SKIP_MIGRATIONS or a
-- partial failure). All statements use IF NOT EXISTS so this is idempotent.

ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_score" real;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_quotes" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_model" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "claim_category" text;

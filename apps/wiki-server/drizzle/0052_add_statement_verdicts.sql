-- Add verdict/verification columns to statements table.
-- These carry forward claim_verdict, claim_verdict_score, etc. from the claims table
-- during claims→statements migration. ~557 claims have verdict data, ~136 have quotes.

ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_score" real;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_quotes" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verdict_model" text;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
ALTER TABLE "statements" ADD COLUMN IF NOT EXISTS "claim_category" text;

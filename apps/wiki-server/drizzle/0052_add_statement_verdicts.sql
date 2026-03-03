-- Add verdict/verification columns to statements table.
-- These carry forward claim_verdict, claim_verdict_score, etc. from the claims table
-- during claims→statements migration. ~557 claims have verdict data, ~136 have quotes.

ALTER TABLE "statements" ADD COLUMN "verdict" text;
ALTER TABLE "statements" ADD COLUMN "verdict_score" real;
ALTER TABLE "statements" ADD COLUMN "verdict_quotes" text;
ALTER TABLE "statements" ADD COLUMN "verdict_model" text;
ALTER TABLE "statements" ADD COLUMN "verified_at" timestamp with time zone;
ALTER TABLE "statements" ADD COLUMN "claim_category" text;

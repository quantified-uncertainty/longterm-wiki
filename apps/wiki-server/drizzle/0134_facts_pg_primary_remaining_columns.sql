-- Add remaining FactBase YAML fields to PG facts table.
-- validEnd and currency were added in 0129; this adds the remaining 5 fields
-- needed for PG to become the source of truth for FactBase facts.
-- See discussion #2950 (step 7).

ALTER TABLE facts ADD COLUMN IF NOT EXISTS source_quote text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS usd_equivalent real;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS exchange_rate real;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS exchange_rate_date text;
ALTER TABLE facts ADD COLUMN IF NOT EXISTS dollar_year integer;

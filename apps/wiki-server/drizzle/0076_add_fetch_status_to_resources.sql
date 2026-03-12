-- Add fetch_status and last_fetched_at columns to resources table.
-- fetch_status tracks the outcome of the last source-fetch (ok/dead/paywall/error).
-- last_fetched_at records when the source-fetcher last attempted to fetch the resource.
-- See GitHub issue #2070.

ALTER TABLE resources ADD COLUMN IF NOT EXISTS fetch_status TEXT;
ALTER TABLE resources ADD COLUMN IF NOT EXISTS last_fetched_at TIMESTAMP WITH TIME ZONE;

-- Add full_text column to citation_content table.
-- fullTextPreview (50KB) remains for fast access; full_text stores the complete fetched content
-- for durable cross-environment reuse. source-fetcher.ts writes full_text after successful fetches
-- and checks PostgreSQL before SQLite for cross-machine cache hits.

ALTER TABLE "citation_content" ADD COLUMN "full_text" text;

CREATE INDEX IF NOT EXISTS "idx_cc_fetched_at" ON "citation_content" ("fetched_at");
CREATE INDEX IF NOT EXISTS "idx_cc_http_status" ON "citation_content" ("http_status");

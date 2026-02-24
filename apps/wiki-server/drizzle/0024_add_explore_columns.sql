-- Add columns needed for the explore page endpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "research_importance" integer;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "tactical_value" integer;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "backlink_count" integer;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "risk_category" text;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "date_created" text;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "recommended_score" real;
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "clusters" jsonb;

-- Index for recommended score sorting
CREATE INDEX IF NOT EXISTS "idx_wp_recommended_score" ON "wiki_pages" ("recommended_score");

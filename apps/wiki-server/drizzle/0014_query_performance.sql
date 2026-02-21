-- 1. Compound index on hallucination_risk_snapshots for "latest per page" queries
CREATE INDEX IF NOT EXISTS "idx_hrs_page_computed" ON "hallucination_risk_snapshots" USING btree ("page_id", "computed_at" DESC);

-- 2. Add search_vector tsvector column to resources (same pattern as wiki_pages)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'resources' AND column_name = 'search_vector') THEN
    ALTER TABLE "resources" ADD COLUMN "search_vector" tsvector;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_res_search_vector" ON "resources" USING gin ("search_vector");
--> statement-breakpoint

-- 3. Backfill search_vector for existing resources
UPDATE resources SET search_vector =
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(abstract, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(review, '')), 'D')
WHERE search_vector IS NULL;

-- Search improvements: pg_trgm for typo tolerance, GIN on clusters for faster filtering

-- 1. Enable pg_trgm extension (for similarity/trigram matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. GIN index on wiki_pages.clusters for @> containment queries
CREATE INDEX IF NOT EXISTS "idx_wp_clusters_gin" ON "wiki_pages" USING gin ("clusters");

-- 3. GIN trigram index on wiki_pages.title for fuzzy/prefix matching fallback
CREATE INDEX IF NOT EXISTS "idx_wp_title_trgm" ON "wiki_pages" USING gin ("title" gin_trgm_ops);

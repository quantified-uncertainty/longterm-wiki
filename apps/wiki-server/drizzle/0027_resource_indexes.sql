-- Add missing indexes for resource queries:
-- GIN on tags/authors for array containment queries (@>),
-- created_at for "recently added" queries.

CREATE INDEX IF NOT EXISTS "idx_res_tags" ON "resources" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "idx_res_authors" ON "resources" USING GIN ("authors");
CREATE INDEX IF NOT EXISTS "idx_res_created_at" ON "resources" ("created_at");

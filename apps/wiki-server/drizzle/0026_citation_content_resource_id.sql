-- Add resource_id column to citation_content to link fetched content to curated resource metadata.
-- This closes the gap between citation_content (URL-keyed fetched data) and resources (curated YAML-sourced metadata).

ALTER TABLE "citation_content" ADD COLUMN IF NOT EXISTS "resource_id" text;
CREATE INDEX IF NOT EXISTS "idx_cc_resource_id" ON "citation_content" ("resource_id");

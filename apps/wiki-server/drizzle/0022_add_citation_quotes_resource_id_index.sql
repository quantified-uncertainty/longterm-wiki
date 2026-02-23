-- Add index on resource_id column in citation_quotes table.
-- Enables efficient lookup of all citation quotes that reference a specific resource,
-- supporting queries like "which wiki claims cite this resource?"

CREATE INDEX IF NOT EXISTS "idx_cq_resource_id" ON "citation_quotes" ("resource_id");

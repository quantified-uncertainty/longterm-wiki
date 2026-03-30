-- Add an index on resources.content_hash for duplicate detection at ingestion time.
-- Enables quick lookup of resources that share the same content hash.
-- Partial index: only index non-null hashes (most resources won't have one yet).

CREATE INDEX IF NOT EXISTS idx_res_content_hash ON resources(content_hash) WHERE content_hash IS NOT NULL;

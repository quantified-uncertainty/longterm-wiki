-- Page Snapshots — dated snapshots of website source pages for fact extraction.
-- Part of Discussion #2928: Websites as Data Feeds (Issue #3652).

CREATE TABLE IF NOT EXISTS "page_snapshots" (
  "id" VARCHAR(10) PRIMARY KEY,
  "website_source_page_id" VARCHAR(10) NOT NULL
    REFERENCES "website_source_pages"("id") ON DELETE CASCADE,
  "url" TEXT NOT NULL,
  "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "content_hash" TEXT NOT NULL,
  "full_text" TEXT NOT NULL,
  "title_at_time" TEXT,
  "http_status" INTEGER NOT NULL DEFAULT 200,
  "content_length" INTEGER NOT NULL DEFAULT 0,
  "extraction_status" TEXT NOT NULL DEFAULT 'pending',
  "extracted_at" TIMESTAMP WITH TIME ZONE,
  "extracted_facts" JSONB,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Lookup snapshots by page, most recent first
CREATE INDEX IF NOT EXISTS "idx_ps_page_fetched"
  ON "page_snapshots" ("website_source_page_id", "fetched_at" DESC);

-- Find snapshots pending extraction
CREATE INDEX IF NOT EXISTS "idx_ps_extraction_status"
  ON "page_snapshots" ("extraction_status");

-- Content-hash dedup: same page + same content = no duplicate snapshot
CREATE UNIQUE INDEX IF NOT EXISTS "idx_ps_page_content_hash"
  ON "page_snapshots" ("website_source_page_id", "content_hash");

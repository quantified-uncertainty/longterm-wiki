-- Add archive_url to resources for Wayback Machine snapshots
ALTER TABLE resources ADD COLUMN IF NOT EXISTS archive_url TEXT;

-- Add fetch_method to citation_content to track provenance (firecrawl, built-in, youtube-transcript, abstract)
ALTER TABLE citation_content ADD COLUMN IF NOT EXISTS fetch_method TEXT;

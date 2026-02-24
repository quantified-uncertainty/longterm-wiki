-- Add audit columns to wiki_pages to track which branch and commit synced each page.
-- Used by scoped-key auth to provide traceability for content sync operations.

ALTER TABLE wiki_pages ADD COLUMN synced_from_branch TEXT;
ALTER TABLE wiki_pages ADD COLUMN synced_from_commit TEXT;

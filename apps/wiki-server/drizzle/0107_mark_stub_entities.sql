-- Mark existing reference-only entities as stubs.
--
-- Entities created by `crux tablebase ensure-entities` or `crux tablebase create-entity`
-- are lightweight FK targets (for personnel records) with no wiki page, no description,
-- no custom fields, no sources, and no related entries. These should not appear in
-- directory page listings.
--
-- Criteria for a stub entity:
--   - No wiki_id (no wiki page)
--   - No description (or NULL description)
--   - No custom_fields (or empty array)
--   - No sources (or empty array)
--   - No related_entries (or empty array)
--   - Not already flagged as stub or deprecated
--
-- This is idempotent: re-running sets the same metadata on the same rows.

UPDATE entities
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"stub": true}'::jsonb,
    updated_at = NOW()
WHERE wiki_id IS NULL
  AND (description IS NULL OR description = '')
  AND (custom_fields IS NULL OR custom_fields = '[]'::jsonb)
  AND (sources IS NULL OR sources = '[]'::jsonb)
  AND (related_entries IS NULL OR related_entries = '[]'::jsonb)
  AND (metadata IS NULL OR metadata->>'stub' IS NULL)
  AND (metadata IS NULL OR metadata->>'deprecated' IS NULL);

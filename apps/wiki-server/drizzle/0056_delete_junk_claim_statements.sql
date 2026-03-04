-- Delete claim-sourced statements that have no structured data.
-- These are low-quality text blobs from the original claims migration
-- that show as "— — —" rows in the /statements/browse UI.
-- The source data still exists in the claims table (source_fact_key = 'claim:{id}').
-- statement_citations has ON DELETE CASCADE on statement_id.
DELETE FROM statements
WHERE source_fact_key LIKE 'claim:%'
  AND property_id IS NULL
  AND value_numeric IS NULL
  AND value_text IS NULL
  AND value_date IS NULL
  AND value_entity_id IS NULL
  AND value_series IS NULL;

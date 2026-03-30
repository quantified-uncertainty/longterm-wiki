-- Add composite index for efficient LEFT JOIN lookups on source_check_verdicts.
-- The existing PK uses COALESCE(field_name, '') which doesn't help when
-- joining on (record_type, record_id) with a field_name IS NULL filter.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scv_record_type_id
  ON source_check_verdicts (record_type, record_id);

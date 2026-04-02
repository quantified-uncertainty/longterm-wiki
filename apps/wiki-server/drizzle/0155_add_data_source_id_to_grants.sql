-- Add data_source_id FK to grants table, linking each grant to the
-- structured data source it was imported from.
-- Nullable: manually-entered grants or legacy imports may not have a source.
ALTER TABLE grants ADD COLUMN data_source_id TEXT REFERENCES data_sources(id) ON DELETE SET NULL;
CREATE INDEX idx_grants_data_source ON grants(data_source_id);

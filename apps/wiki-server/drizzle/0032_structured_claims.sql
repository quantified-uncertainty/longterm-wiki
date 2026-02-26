-- Migration 0032: Structured claims (Wikidata-style entity/property/value)
--
-- Adds structured fields to the claims table for claims that can be
-- decomposed into subject/property/value triples. All columns are nullable —
-- evaluative/causal claims that resist structuring keep these as null.
--
-- See: https://github.com/quantified-uncertainty/longterm-wiki/issues/1164

ALTER TABLE claims
  ADD COLUMN subject_entity VARCHAR,
  ADD COLUMN property VARCHAR,
  ADD COLUMN structured_value VARCHAR,
  ADD COLUMN value_unit VARCHAR,
  ADD COLUMN value_date DATE,
  ADD COLUMN qualifiers JSONB;

-- Index on subject_entity for cross-page consistency queries
CREATE INDEX idx_cl_subject_entity ON claims (subject_entity);

-- Index on property for filtering by property type
CREATE INDEX idx_cl_property ON claims (property);

-- Composite index for deduplication queries (same subject + property + qualifiers)
CREATE INDEX idx_cl_subject_property ON claims (subject_entity, property);

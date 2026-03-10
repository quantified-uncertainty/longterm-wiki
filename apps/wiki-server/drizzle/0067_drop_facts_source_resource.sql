-- Drop the source_resource column from facts table.
-- This column linked KB facts to resource YAML entries via a 16-char hex ID.
-- Resource tracking is now DB-only: the wiki-server matches facts to resources
-- by URL, not by stored IDs in YAML.
--
-- The FK constraint (from 0026_add_referential_integrity_fks.sql) is dropped
-- implicitly when the column is dropped.

ALTER TABLE facts DROP COLUMN IF EXISTS source_resource;

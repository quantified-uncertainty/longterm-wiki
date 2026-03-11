-- Drop the orphaned kb_fact_verifications table.
-- This table was created by an earlier version of migration 0068 which used
-- the name "kb_fact_verifications". Migration 0068 was later modified to
-- create "kb_fact_resource_verifications" instead, but the old table was
-- never cleaned up. It has 0 rows and is not referenced by any code.

DROP TABLE IF EXISTS kb_fact_verifications;

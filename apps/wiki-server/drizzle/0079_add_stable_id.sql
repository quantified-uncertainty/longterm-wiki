-- Add stable_id (10-char alphanumeric) to entity_ids and entities tables.
-- This is the first step toward unified 10-char IDs across the system.
-- See: https://github.com/quantified-uncertainty/longterm-wiki/discussions/2169

ALTER TABLE "entity_ids" ADD COLUMN "stable_id" text UNIQUE;
ALTER TABLE "entities" ADD COLUMN "stable_id" text UNIQUE;

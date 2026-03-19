-- Add thing_type and entity_type to the things search_vector so that
-- searching "benchmark" finds benchmark-type things, "grant" finds grants,
-- and "organization" finds org entities.
--
-- Must DROP + ADD because Postgres does not support ALTER on generated columns.
-- The GIN index is dropped with the column and recreated.

ALTER TABLE things DROP COLUMN IF EXISTS search_vector;
ALTER TABLE things ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(parent_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C') ||
    setweight(to_tsvector('english',
      coalesce(replace(thing_type, '-', ' '), '') || ' ' ||
      coalesce(replace(entity_type, '-', ' '), '')
    ), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_things_search ON things USING GIN(search_vector);

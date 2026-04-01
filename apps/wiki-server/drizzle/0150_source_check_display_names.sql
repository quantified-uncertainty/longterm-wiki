-- Add display name columns to source_check_verdicts.
-- These persist the human-readable names at verdict write time so they
-- survive record deletion/re-import (which orphans the original record ID).
ALTER TABLE source_check_verdicts ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE source_check_verdicts ADD COLUMN IF NOT EXISTS entity_display_name text;

-- Add program_id column to grants, linking individual grants to funding programs.
-- Nullable because most existing grants won't have a program association initially.
-- Soft reference (no FK constraint), consistent with how organizationId works.

ALTER TABLE grants ADD COLUMN IF NOT EXISTS program_id TEXT;

CREATE INDEX IF NOT EXISTS idx_grants_program ON grants(program_id);

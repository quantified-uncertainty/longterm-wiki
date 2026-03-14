-- Add metadata JSONB column to entities table.
-- Stores type-specific structured data (e.g., orgType for organizations,
-- developer for AI models) that doesn't warrant its own column.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS metadata jsonb;

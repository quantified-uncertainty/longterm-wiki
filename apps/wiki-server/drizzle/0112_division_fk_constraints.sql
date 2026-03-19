-- Add missing FK constraints on divisions and division_personnel tables.
--
-- 1. division_personnel.division_id → divisions.id (CASCADE on delete)
-- 2. division_personnel.person_id → entities.stable_id (SET NULL on delete)
-- 3. divisions.parent_org_id → entities.stable_id (SET NULL on delete)
--
-- For SET NULL FKs, the column must be nullable. This migration:
--   a) Drops NOT NULL on person_id and parent_org_id where SET NULL is needed
--   b) Cleans up any orphan rows that would violate the new constraints
--   c) Adds the FK constraints idempotently (IF NOT EXISTS)
--
-- Both tables are small (<100 rows each) — runs in milliseconds.

-- ============================================================
-- Step 1: Clean up orphan division_personnel rows
-- ============================================================

-- Delete division_personnel rows whose division_id doesn't exist in divisions
DELETE FROM division_personnel dp
WHERE NOT EXISTS (
  SELECT 1 FROM divisions d WHERE d.id = dp.division_id
);

-- Add a display-name fallback column to preserve person names that don't
-- resolve to an entity stable_id. This mirrors the pattern in the
-- `personnel` table (personDisplayName column).
ALTER TABLE division_personnel
  ADD COLUMN IF NOT EXISTS person_display_name TEXT;

-- Copy non-matching person_id values into person_display_name before
-- nulling them out, so the human-readable name is not lost.
UPDATE division_personnel dp
SET person_display_name = dp.person_id
WHERE dp.person_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM entities e WHERE e.stable_id = dp.person_id
  );

-- Make person_id nullable so SET NULL on delete can work
ALTER TABLE division_personnel ALTER COLUMN person_id DROP NOT NULL;

-- Null out person_id values that don't exist in entities.stable_id
UPDATE division_personnel dp
SET person_id = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM entities e WHERE e.stable_id = dp.person_id
);

-- ============================================================
-- Step 2: Clean up orphan divisions rows
-- ============================================================

-- Make parent_org_id nullable so SET NULL on delete can work
ALTER TABLE divisions ALTER COLUMN parent_org_id DROP NOT NULL;

-- Null out parent_org_id values that don't exist in entities.stable_id
UPDATE divisions d
SET parent_org_id = NULL
WHERE NOT EXISTS (
  SELECT 1 FROM entities e WHERE e.stable_id = d.parent_org_id
);

-- ============================================================
-- Step 3: Add FK constraints (idempotent — checks pg_constraint)
-- ============================================================

-- FK: division_personnel.division_id → divisions.id (CASCADE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dp_division_id'
  ) THEN
    ALTER TABLE division_personnel
      ADD CONSTRAINT fk_dp_division_id
      FOREIGN KEY (division_id) REFERENCES divisions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- FK: division_personnel.person_id → entities.stable_id (SET NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dp_person_id'
  ) THEN
    ALTER TABLE division_personnel
      ADD CONSTRAINT fk_dp_person_id
      FOREIGN KEY (person_id) REFERENCES entities(stable_id) ON DELETE SET NULL;
  END IF;
END $$;

-- FK: divisions.parent_org_id → entities.stable_id (SET NULL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_div_parent_org_id'
  ) THEN
    ALTER TABLE divisions
      ADD CONSTRAINT fk_div_parent_org_id
      FOREIGN KEY (parent_org_id) REFERENCES entities(stable_id) ON DELETE SET NULL;
  END IF;
END $$;

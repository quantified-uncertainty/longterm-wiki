-- Deduplicate funding_programs before adding unique constraint on (org_id, name).
--
-- Uses dynamic dedup (ROW_NUMBER window function) instead of hardcoding specific
-- duplicate IDs. This is safer because it handles ALL duplicates, including ones
-- that may have been created after the migration was written.
--
-- Pattern follows GitLab's dedup-before-constraint approach and matches our own
-- migration 0108_natural_key_uniqueness.sql which used the same ROW_NUMBER pattern.
--
-- Incident context: The original version hardcoded one duplicate ID but missed 2
-- others, causing a 3-hour outage (2026-03-28) when the CREATE UNIQUE INDEX failed.

-- Step 1: Reassign grants from duplicate programs to canonical (earliest-created) programs.
-- For each (org_id, name) group, the row with the lowest created_at is canonical.
UPDATE grants g
SET program_id = canonical.canonical_id
FROM (
  -- Find duplicates: rows where row_number > 1 within each (org_id, name) group
  SELECT fp.id AS dup_id, first_value(fp.id) OVER (
    PARTITION BY fp.org_id, fp.name ORDER BY fp.created_at, fp.id
  ) AS canonical_id
  FROM funding_programs fp
) canonical
WHERE g.program_id = canonical.dup_id
  AND canonical.dup_id != canonical.canonical_id;

-- Step 2: Delete things entries for duplicate programs
DELETE FROM things
WHERE source_table = 'funding_programs'
  AND source_id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY org_id, name ORDER BY created_at, id
      ) AS rn
      FROM funding_programs
    ) ranked WHERE rn > 1
  );

-- Step 3: Delete duplicate funding programs (keep earliest-created per org_id+name)
DELETE FROM funding_programs
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY org_id, name ORDER BY created_at, id
    ) AS rn
    FROM funding_programs
  ) ranked WHERE rn > 1
);

-- Step 4: Add unique constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_fp_org_name ON funding_programs (org_id, name);

-- Add FK constraint: grants.program_id -> funding_programs.id
--
-- Step 1: NULL out any orphaned program_id values that don't exist in funding_programs.
-- Step 2: Add the FK constraint with ON DELETE SET NULL.
--
-- This is safe because:
--   - grants and funding_programs are small tables (hundreds of rows)
--   - The UPDATE only touches rows with dangling references
--   - The FK constraint is lightweight to add on small tables

-- Clean orphaned program_ids
UPDATE grants
SET program_id = NULL, updated_at = NOW()
WHERE program_id IS NOT NULL
  AND program_id NOT IN (SELECT id FROM funding_programs);

-- Add FK constraint
ALTER TABLE "grants"
  ADD CONSTRAINT "grants_program_id_funding_programs_id_fk"
  FOREIGN KEY ("program_id")
  REFERENCES "public"."funding_programs"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;

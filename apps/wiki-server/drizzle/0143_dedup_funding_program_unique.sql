-- Delete duplicate "Technical AI Safety RFP (2025)" funding program.
-- Canonical ID Kb9uB1Zp1E (from import seed prog|coefficient-giving|technical-ai-safety-rfp-2025).
-- Duplicate ID a2NsC7Lk0g was inserted by a prior sync with a different seed.
-- Also reassign any grants pointing to the duplicate before deleting.

-- Reassign grants that reference the duplicate to the canonical program
UPDATE grants
SET program_id = 'Kb9uB1Zp1E'
WHERE program_id = 'a2NsC7Lk0g';

-- Delete things entry for the duplicate
DELETE FROM things
WHERE source_table = 'funding_programs' AND source_id = 'a2NsC7Lk0g';

-- Delete the duplicate funding program
DELETE FROM funding_programs
WHERE id = 'a2NsC7Lk0g';

-- Add unique constraint on (org_id, name) to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS uq_fp_org_name ON funding_programs (org_id, name);

-- Migration 0030: Fix claims numeric precision and add NOT NULL constraint on claim_mode
--
-- 1. Upgrade value_numeric / value_low / value_high from REAL (4-byte float, ~7 decimal
--    digits) to DOUBLE PRECISION (8-byte float, ~15 decimal digits). This matters for
--    values like world-population figures (7,300,000,000) which lose significant bits in
--    REAL storage.
--
-- 2. Add NOT NULL DEFAULT 'endorsed' on claim_mode. The Phase 2 migration already
--    back-filled existing rows to 'endorsed', so this constraint is safe to apply.
--    New inserts that omit claim_mode will correctly default to 'endorsed'.

ALTER TABLE claims
  ALTER COLUMN value_numeric TYPE double precision,
  ALTER COLUMN value_low     TYPE double precision,
  ALTER COLUMN value_high    TYPE double precision;

-- Ensure no NULLs remain (back-fill from Phase 2 migration already handled this)
UPDATE claims SET claim_mode = 'endorsed' WHERE claim_mode IS NULL;

ALTER TABLE claims
  ALTER COLUMN claim_mode SET NOT NULL,
  ALTER COLUMN claim_mode SET DEFAULT 'endorsed';

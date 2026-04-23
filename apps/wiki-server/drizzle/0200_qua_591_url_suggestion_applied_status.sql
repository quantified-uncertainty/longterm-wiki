-- QUA-591: allow `applied` status on sourcing_url_suggestions.
--
-- The sourcing-apply-suggestions command consumes rows with
-- status='approved'/'auto_verified', swaps the URL on the evidence row,
-- re-runs verification, and marks the suggestion as 'applied' so re-runs
-- of the command are naturally idempotent.
--
-- The table has O(thousands) of rows, so plain ADD CONSTRAINT is fine —
-- the NOT VALID + VALIDATE pattern is only needed for large tables.

DO $$ BEGIN
  ALTER TABLE "sourcing_url_suggestions"
    DROP CONSTRAINT IF EXISTS chk_sus_status;
  ALTER TABLE "sourcing_url_suggestions"
    ADD CONSTRAINT chk_sus_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'auto_verified', 'applied'));
END $$;

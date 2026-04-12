-- Fix migration 0173: the CHECK constraint for groundskeeper_runs.event was
-- missing three valid event types that already exist in production data:
-- 'circuit_breaker_reset', 'half_open_attempt', 'half_open_success'.
--
-- These values are defined in VALID_GK_EVENTS (api-types.ts) and accepted by
-- the Zod schema, but were omitted from the CHECK constraint, causing the
-- migration job to fail on deploy.
--
-- Strategy: drop the old constraint if it exists, then create the correct one.

-- Drop the incomplete constraint (if 0173 partially succeeded on a prior attempt)
DO $$ BEGIN
  ALTER TABLE "groundskeeper_runs" DROP CONSTRAINT IF EXISTS chk_gkr_event;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Add the correct constraint with all valid event types
DO $$ BEGIN
  ALTER TABLE "groundskeeper_runs"
    ADD CONSTRAINT chk_gkr_event
    CHECK (event IN (
      'success',
      'failure',
      'error',
      'circuit_breaker_tripped',
      'circuit_breaker_reset',
      'half_open_attempt',
      'half_open_success',
      'skipped'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

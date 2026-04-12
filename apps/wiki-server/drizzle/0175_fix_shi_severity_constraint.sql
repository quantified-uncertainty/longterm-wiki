-- Fix migration 0173: the CHECK constraint for service_health_incidents.severity
-- used ('P0', 'P1', 'P2') but the application writes 'critical' (per
-- groundskeeper/src/incident-buffer.ts and health-check.ts). Production has 4
-- rows with severity='critical', causing the ADD CONSTRAINT in 0173 to fail.
--
-- The P0/P1/P2 taxonomy was never implemented in code. Align the constraint
-- with actual usage: critical/warning/info.
--
-- Strategy: drop the old constraint if it exists, then create the correct one.

DO $$ BEGIN
  ALTER TABLE "service_health_incidents" DROP CONSTRAINT IF EXISTS chk_shi_severity;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "service_health_incidents"
    ADD CONSTRAINT chk_shi_severity
    CHECK (severity IN ('critical', 'warning', 'info'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

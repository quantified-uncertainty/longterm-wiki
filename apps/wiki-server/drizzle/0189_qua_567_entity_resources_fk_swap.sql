-- QUA-567 Phase B.4: swap entity_resources.resource_id FK reference from
-- resources.id → resources.stable_id.
--
-- This ticket is one of the 17-table migration from QUA-549 Phase B. Pattern
-- follows QUA-564 (migration 0187) — in-place / Option B: column name stays
-- `resource_id`, only the FK reference target changes, and the values are
-- rewritten in-place from hex16 → sid_.
--
-- Prod state at time of authoring (2026-04-17, via direct query):
--   - 4,182 rows in entity_resources, all hex16 format
--   - 0 sid_ rows, 0 nulls, 0 orphans (every resource_id has a matching resource)
--   - resources.stable_id is 100% populated (22,976/22,976)
--
-- The corresponding things_search MV JOIN fix ships in migration 0189.

-- ────────────────────────────────────────────────────────────────────────
-- Drop old FK. Defensive IF EXISTS covers both the Drizzle-generated name
-- and the postgres default (<table>_<column>_fkey). Only one will exist in
-- any given environment.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE "entity_resources" DROP CONSTRAINT IF EXISTS "entity_resources_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "entity_resources" DROP CONSTRAINT IF EXISTS "entity_resources_resource_id_fkey";--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- Backfill: rewrite hex16 resource_id values to the corresponding sid_
-- value via JOIN on resources. Guarded by NOT LIKE 'sid_%' so re-runs and
-- environments that are already migrated are no-ops. 4,182 rows in prod;
-- an indexed JOIN UPDATE completes well under statement_timeout.
-- ────────────────────────────────────────────────────────────────────────
UPDATE "entity_resources" er
SET resource_id = r.stable_id
FROM "resources" r
WHERE er.resource_id = r.id
  AND er.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- Add new FK pointing at resources.stable_id. Preserves the existing
-- CASCADE semantics. Idempotent so the migration can re-run safely.
-- ────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'entity_resources_resource_id_resources_stable_id_fk'
      AND table_name = 'entity_resources'
  ) THEN
    ALTER TABLE "entity_resources"
      ADD CONSTRAINT "entity_resources_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;

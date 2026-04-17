-- QUA-564 Phase B.1: swap publications.resource_id and resource_policy_docs.resource_id
-- FK references from resources.id → resources.stable_id.
--
-- This is the template PR for QUA-549 Phase B (17-table FK migration). Only these
-- two tables are swapped here; the other 15 ship in QUA-572/573/574/565/566/567/
-- 568/569. See QUA-549 for the parent + full ticket list.
--
-- Both tables are 0 rows in prod, so no backfill is needed. The DROP+ADD CONSTRAINT
-- is protected with IF EXISTS for both likely Drizzle-generated names and the
-- postgres default (<table>_<column>_fkey) so this migration is idempotent.
--
-- Approach: in-place (Option B). Column name stays `resource_id`; only the FK
-- reference target changes. No code churn from renaming column references.

-- ────────────────────────────────────────────────────────────────────────
-- publications.resource_id → resources.stable_id (SET NULL)
-- ────────────────────────────────────────────────────────────────────────

-- Defensive: one of these two names will match depending on how the FK was
-- originally created. If neither matches (FK already swapped), IF EXISTS silences.
ALTER TABLE "publications" DROP CONSTRAINT IF EXISTS "publications_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "publications" DROP CONSTRAINT IF EXISTS "publications_resource_id_fkey";--> statement-breakpoint

-- Backfill: rewrite any non-null resource_id values from hex16 → sid_ via join
-- on resources. No-op on prod (0 rows) but defensive for dev/staging/test envs.
UPDATE "publications" p
SET resource_id = r.stable_id
FROM "resources" r
WHERE p.resource_id = r.id
  AND p.resource_id IS NOT NULL
  AND p.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

-- Add new FK pointing at resources.stable_id, preserving SET NULL semantics.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'publications_resource_id_resources_stable_id_fk'
      AND table_name = 'publications'
  ) THEN
    ALTER TABLE "publications"
      ADD CONSTRAINT "publications_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- resource_policy_docs.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- resource_id is both PK and FK. Only the FK is swapped; the PK constraint is
-- independent and stays in place.

ALTER TABLE "resource_policy_docs" DROP CONSTRAINT IF EXISTS "resource_policy_docs_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "resource_policy_docs" DROP CONSTRAINT IF EXISTS "resource_policy_docs_resource_id_fkey";--> statement-breakpoint

UPDATE "resource_policy_docs" rpd
SET resource_id = r.stable_id
FROM "resources" r
WHERE rpd.resource_id = r.id
  AND rpd.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_policy_docs_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_policy_docs'
  ) THEN
    ALTER TABLE "resource_policy_docs"
      ADD CONSTRAINT "resource_policy_docs_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;

-- QUA-564 Phase B.1: swap publications.resource_id and resource_policy_docs.resource_id
-- FK references from resources.id → resources.stable_id.
--
-- This is the template PR for QUA-549 Phase B (17-table FK migration). Only these
-- two tables are swapped here; the other 15 ship in QUA-572/573/574/565/566/567/
-- 568/569. See QUA-549 for the parent + full ticket list.
--
-- Both tables are 0 rows in prod, so no backfill is needed. The template uses
-- patterns that scale safely to the larger Phase B tables:
--   1. Dynamic DROP CONSTRAINT (queries information_schema for any FK on the
--      column pointing at resources.id) — robust to constraint names we don't know.
--   2. NOT VALID + VALIDATE CONSTRAINT pattern per .claude/rules/database-migrations.md
--      (QUA-302/QUA-156 incident note) — minimizes ACCESS EXCLUSIVE lock time.
--   3. r.stable_id IS NOT NULL guard on the backfill UPDATE — prevents silent
--      NULL overwrite if any resources row is missing a stable_id.
--
-- Approach: in-place (Option B). Column name stays `resource_id`; only the FK
-- reference target changes. No code churn from renaming column references.

-- ────────────────────────────────────────────────────────────────────────
-- publications.resource_id → resources.stable_id (SET NULL)
-- ────────────────────────────────────────────────────────────────────────

-- Dynamic DROP: find any FK constraint on publications.resource_id referencing
-- resources.id (regardless of its generated name) and drop it. Idempotent.
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name
   AND rc.unique_constraint_schema = ccu.constraint_schema
  WHERE tc.table_name = 'publications'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'resource_id'
    AND ccu.table_name = 'resources'
    AND ccu.column_name = 'id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "publications" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;--> statement-breakpoint

-- Backfill: rewrite any non-null resource_id values from hex16 → sid_ via join
-- on resources. No-op on prod (0 rows) but defensive for dev/staging/test envs.
-- The r.stable_id IS NOT NULL guard prevents silently overwriting a real link
-- with NULL if some resources row is missing its stable_id.
UPDATE "publications" p
SET resource_id = r.stable_id
FROM "resources" r
WHERE p.resource_id = r.id
  AND p.resource_id IS NOT NULL
  AND p.resource_id NOT LIKE 'sid_%'
  AND r.stable_id IS NOT NULL;--> statement-breakpoint

-- Add new FK pointing at resources.stable_id, preserving SET NULL semantics.
-- NOT VALID + VALIDATE CONSTRAINT pattern: adds the constraint as metadata
-- (ACCESS EXCLUSIVE for milliseconds, no row scan) then validates separately
-- under the lighter SHARE UPDATE EXCLUSIVE lock. No-op cost on 0-row tables
-- but this is the template for future Phase B tables with real data.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'publications_resource_id_resources_stable_id_fk'
      AND table_name = 'publications'
  ) THEN
    ALTER TABLE "publications"
      ADD CONSTRAINT "publications_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id")
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "publications"
  VALIDATE CONSTRAINT "publications_resource_id_resources_stable_id_fk";--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- resource_policy_docs.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- resource_id is both PK and FK. Only the FK is swapped; the PK constraint is
-- independent and stays in place.

DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name
   AND rc.unique_constraint_schema = ccu.constraint_schema
  WHERE tc.table_name = 'resource_policy_docs'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'resource_id'
    AND ccu.table_name = 'resources'
    AND ccu.column_name = 'id'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "resource_policy_docs" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;--> statement-breakpoint

-- Backfill with stable_id-non-null guard (critical here because resource_id is
-- the PK; silently overwriting to NULL would fail PK or create a duplicate).
UPDATE "resource_policy_docs" rpd
SET resource_id = r.stable_id
FROM "resources" r
WHERE rpd.resource_id = r.id
  AND rpd.resource_id NOT LIKE 'sid_%'
  AND r.stable_id IS NOT NULL;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_policy_docs_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_policy_docs'
  ) THEN
    ALTER TABLE "resource_policy_docs"
      ADD CONSTRAINT "resource_policy_docs_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id")
      ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "resource_policy_docs"
  VALIDATE CONSTRAINT "resource_policy_docs_resource_id_resources_stable_id_fk";

-- QUA-565 Phase B.2: swap 3 tiny tables from resources.id → resources.stable_id.
--
-- Part of QUA-549 Phase B. Follows the in-place pattern established by
-- QUA-549 (0186, resource_content_versions) and QUA-564 (Phase B.1,
-- publications + resource_policy_docs).
--
-- Scope (prod row counts, enumerated 2026-04-17):
--   resource_tabular_sources — 14 rows, all hex16 — FK ON DELETE CASCADE
--   source_snapshots         — 14 rows, all hex16 — FK ON DELETE SET NULL
--   research_area_papers     — 73 rows, all hex16 — FK ON DELETE SET NULL
--
-- Pre-flight: 84 distinct resource_ids across the 3 tables all resolve to
-- a resources row with a populated stable_id; 0 orphans.
--
-- Scope note: citation_quotes was in the original ticket scope but was
-- deferred to its own Phase B.6 ticket due to a larger 12-file code surface.
-- resource_content_versions also originally appeared in this phase but was
-- shipped early as the QUA-549 pilot (migration 0186).
--
-- Column name stays `resource_id` on all three tables; only the FK reference
-- target and the stored value change. Same minimal-churn approach as B.1.
--
-- Existing FK constraint names (enumerated from prod pg_constraint 2026-04-17):
--   research_area_papers_resource_id_fkey     (postgres default)
--   resource_tabular_sources_resource_id_fkey (postgres default)
--   source_snapshots_resource_id_fkey         (postgres default)
-- The DROP CONSTRAINT IF EXISTS below also covers the Drizzle-generated
-- `<table>_<col>_<target_table>_<target_col>_fk` name, so this migration
-- works against older dev/staging databases that used that convention.

-- ────────────────────────────────────────────────────────────────────────
-- resource_tabular_sources.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- resource_id is both PK and FK on this table. Only the FK changes here;
-- the PK constraint is independent and stays in place.

ALTER TABLE "resource_tabular_sources" DROP CONSTRAINT IF EXISTS "resource_tabular_sources_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "resource_tabular_sources" DROP CONSTRAINT IF EXISTS "resource_tabular_sources_resource_id_fkey";--> statement-breakpoint

UPDATE "resource_tabular_sources" rts
SET resource_id = r.stable_id
FROM "resources" r
WHERE rts.resource_id = r.id
  AND rts.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

-- Fail loudly (with a clear message) rather than letting ADD CONSTRAINT
-- reject with a generic FK error. Pre-flight found 0 orphans 2026-04-17.
DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM resource_tabular_sources t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-565 migration aborted: % resource_tabular_sources row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_tabular_sources_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_tabular_sources'
  ) THEN
    ALTER TABLE "resource_tabular_sources"
      ADD CONSTRAINT "resource_tabular_sources_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- source_snapshots.resource_id → resources.stable_id (SET NULL)
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE "source_snapshots" DROP CONSTRAINT IF EXISTS "source_snapshots_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "source_snapshots" DROP CONSTRAINT IF EXISTS "source_snapshots_resource_id_fkey";--> statement-breakpoint

UPDATE "source_snapshots" ss
SET resource_id = r.stable_id
FROM "resources" r
WHERE ss.resource_id = r.id
  AND ss.resource_id IS NOT NULL
  AND ss.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM source_snapshots t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-565 migration aborted: % source_snapshots row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'source_snapshots_resource_id_resources_stable_id_fk'
      AND table_name = 'source_snapshots'
  ) THEN
    ALTER TABLE "source_snapshots"
      ADD CONSTRAINT "source_snapshots_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- research_area_papers.resource_id → resources.stable_id (SET NULL)
-- ────────────────────────────────────────────────────────────────────────

ALTER TABLE "research_area_papers" DROP CONSTRAINT IF EXISTS "research_area_papers_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "research_area_papers" DROP CONSTRAINT IF EXISTS "research_area_papers_resource_id_fkey";--> statement-breakpoint

UPDATE "research_area_papers" rap
SET resource_id = r.stable_id
FROM "resources" r
WHERE rap.resource_id = r.id
  AND rap.resource_id IS NOT NULL
  AND rap.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM research_area_papers t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-565 migration aborted: % research_area_papers row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'research_area_papers_resource_id_resources_stable_id_fk'
      AND table_name = 'research_area_papers'
  ) THEN
    ALTER TABLE "research_area_papers"
      ADD CONSTRAINT "research_area_papers_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE SET NULL;
  END IF;
END $$;

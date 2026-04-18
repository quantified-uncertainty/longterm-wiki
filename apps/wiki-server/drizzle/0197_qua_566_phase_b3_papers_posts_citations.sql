-- QUA-566 Phase B.3: swap papers/forum-posts/citations FK tables from
-- resources.id → resources.stable_id.
--
-- Part of QUA-549 Phase B. Follows the in-place pattern established by
-- QUA-549 (0186), QUA-564 Phase B.1 (0187), QUA-565 Phase B.2 (0188),
-- QUA-567 Phase B.4 (0189-0190), QUA-568 Phase B.5 (0191).
--
-- Scope (prod row counts enumerated 2026-04-18 via /api/resources/all-details
-- + /api/resources/citations/all + /api/resources/stats):
--   resource_papers       —   431 rows, 100% hex16 — FK ON DELETE CASCADE
--   resource_forum_posts  — 5,267 rows, 100% hex16 — FK ON DELETE CASCADE
--   resource_citations    — 5,962 rows (4,526 distinct resource_ids), 100%
--                           hex16 — FK ON DELETE CASCADE
--
-- Pre-flight: 0 orphans against resources.id; resources.stable_id coverage
-- 22,976/22,976 (100%, per QUA-536 Phase A).
--
-- Column name stays `resource_id` on all three tables; only the FK reference
-- target and the stored value change. Same minimal-churn approach as B.1/B.2.
--
-- Existing FK constraint naming: Drizzle-generated
-- `<table>_<col>_<target_table>_<target_col>_fk` (present in this repo's
-- development databases) and the postgres default `<table>_<col>_fkey` (not
-- known to exist for these 3 tables but dropped defensively for dev/staging
-- parity with earlier phases).

-- ────────────────────────────────────────────────────────────────────────
-- resource_papers.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- resource_id is the PK on this table (one row per resource). Only the FK
-- changes here; the PK constraint is independent and stays in place.

ALTER TABLE "resource_papers" DROP CONSTRAINT IF EXISTS "resource_papers_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "resource_papers" DROP CONSTRAINT IF EXISTS "resource_papers_resource_id_fkey";--> statement-breakpoint

UPDATE "resource_papers" rp
SET resource_id = r.stable_id
FROM "resources" r
WHERE rp.resource_id = r.id
  AND rp.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

-- Fail loudly (with a clear message) rather than letting ADD CONSTRAINT
-- reject with a generic FK error. Pre-flight found 0 orphans 2026-04-18.
DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM resource_papers t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-566 migration aborted: % resource_papers row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_papers_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_papers'
  ) THEN
    ALTER TABLE "resource_papers"
      ADD CONSTRAINT "resource_papers_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- resource_forum_posts.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- resource_id is the PK on this table.

ALTER TABLE "resource_forum_posts" DROP CONSTRAINT IF EXISTS "resource_forum_posts_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "resource_forum_posts" DROP CONSTRAINT IF EXISTS "resource_forum_posts_resource_id_fkey";--> statement-breakpoint

UPDATE "resource_forum_posts" rfp
SET resource_id = r.stable_id
FROM "resources" r
WHERE rfp.resource_id = r.id
  AND rfp.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM resource_forum_posts t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-566 migration aborted: % resource_forum_posts row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_forum_posts_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_forum_posts'
  ) THEN
    ALTER TABLE "resource_forum_posts"
      ADD CONSTRAINT "resource_forum_posts_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- resource_citations.resource_id → resources.stable_id (CASCADE)
-- ────────────────────────────────────────────────────────────────────────
-- (resource_id, page_id) is the composite PK on this table.

ALTER TABLE "resource_citations" DROP CONSTRAINT IF EXISTS "resource_citations_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "resource_citations" DROP CONSTRAINT IF EXISTS "resource_citations_resource_id_fkey";--> statement-breakpoint

UPDATE "resource_citations" rc
SET resource_id = r.stable_id
FROM "resources" r
WHERE rc.resource_id = r.id
  AND rc.resource_id NOT LIKE 'sid_%';--> statement-breakpoint

DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM resource_citations t
  WHERE t.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = t.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-566 migration aborted: % resource_citations row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_citations_resource_id_resources_stable_id_fk'
      AND table_name = 'resource_citations'
  ) THEN
    ALTER TABLE "resource_citations"
      ADD CONSTRAINT "resource_citations_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id") ON DELETE CASCADE;
  END IF;
END $$;

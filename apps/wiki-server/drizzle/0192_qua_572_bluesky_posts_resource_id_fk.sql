-- QUA-572 Phase B.1b: migrate bluesky_posts.resource_id FK from
-- resources.id → resources.stable_id.
--
-- Part of QUA-549 Phase B. Follows the in-place pattern established by
-- 0186 (resource_content_versions), 0187 (publications + resource_policy_docs,
-- QUA-564), 0188 (QUA-565 tiny tables), 0189 (QUA-567 entity_resources),
-- and 0191 (QUA-568 source_check_evidence).
--
-- Pre-flight (prod, 2026-04-18):
--   0 rows in bluesky_posts (zero-row table).
--   Existing FK: bluesky_posts_resource_id_fkey
--     (postgres default name, ON DELETE SET NULL).
--   0 orphans trivially (0 rows).
--
-- Column name stays `resource_id`; only the FK reference target changes,
-- preserving SET NULL onDelete. The backfill UPDATE below is a no-op on
-- prod but defensive for dev/staging/test envs that may have ingested
-- test data.

-- Step 1: drop the existing FK on resources.id. Covers both the Drizzle-
-- generated name (used by older dev databases) and the postgres default
-- (active in prod per 2026-04-18 enumeration).
ALTER TABLE "bluesky_posts"
  DROP CONSTRAINT IF EXISTS "bluesky_posts_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "bluesky_posts"
  DROP CONSTRAINT IF EXISTS "bluesky_posts_resource_id_fkey";--> statement-breakpoint

-- Defensive: fail loudly if an FK on resource_id → resources.id still
-- exists under an unexpected name (e.g. drift beyond the two variants above).
-- Prevents the UPDATE below from running against a still-referenced column.
DO $$
DECLARE
  remaining_fk TEXT;
BEGIN
  SELECT conname INTO remaining_fk
  FROM pg_constraint
  WHERE conrelid = 'bluesky_posts'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                       WHERE attrelid = 'bluesky_posts'::regclass
                         AND attname = 'resource_id')]
    AND confrelid = 'resources'::regclass
    AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                        WHERE attrelid = 'resources'::regclass
                          AND attname = 'id')]
  LIMIT 1;
  IF remaining_fk IS NOT NULL THEN
    RAISE EXCEPTION 'QUA-572 migration aborted: unexpected FK constraint "%" still points bluesky_posts.resource_id at resources.id after DROP attempts. Add an explicit DROP for this name and re-run.', remaining_fk;
  END IF;
END $$;--> statement-breakpoint

-- Step 2: backfill resource_id values from hex16 → sid_ via join on
-- resources. No-op on prod (0 rows) but defensive for other envs.
-- The r.stable_id IS NOT NULL guard prevents silently overwriting a
-- real link with NULL if some resources row is missing its stable_id.
UPDATE "bluesky_posts" bp
SET resource_id = r.stable_id
FROM "resources" r
WHERE bp.resource_id = r.id
  AND bp.resource_id IS NOT NULL
  AND bp.resource_id NOT LIKE 'sid_%'
  AND r.stable_id IS NOT NULL;--> statement-breakpoint

-- Step 3: orphan check — fail fast rather than letting ADD CONSTRAINT
-- reject with a generic FK error. Trivially passes on prod (0 rows).
DO $$
DECLARE orphan_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM bluesky_posts bp
  WHERE bp.resource_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = bp.resource_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-572 migration aborted: % bluesky_posts row(s) have a resource_id that does not map to any resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;--> statement-breakpoint

-- Step 4: add the new FK pointing at resources.stable_id, preserving
-- SET NULL. Wrapped in IF NOT EXISTS for idempotency on replay.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'bluesky_posts_resource_id_resources_stable_id_fk'
      AND table_name = 'bluesky_posts'
  ) THEN
    ALTER TABLE "bluesky_posts"
      ADD CONSTRAINT "bluesky_posts_resource_id_resources_stable_id_fk"
      FOREIGN KEY ("resource_id") REFERENCES "resources"("stable_id")
      ON DELETE SET NULL;
  END IF;
END $$;

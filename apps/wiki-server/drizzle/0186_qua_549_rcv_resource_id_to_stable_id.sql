-- QUA-549 Phase B: migrate resource_content_versions.resource_id from
-- referencing resources.id (legacy hex16) to resources.stable_id (canonical
-- `sid_<10>`).
--
-- Part of Phase B (QUA-549) of the resources-FK migration plan designed in
-- QUA-498. Pilot table for the pattern; depends on Phase A (QUA-536) having
-- populated resources.stable_id NOT NULL + duplicate-free.
--
-- Pre-flight (prod, 2026-04-16):
--   52 rows with non-null resource_id, 0 orphans.
--   Existing FK: resource_content_versions_resource_id_resources_id_fk
--     ON DELETE SET NULL (matches schema.ts).
--   Preserve the SET NULL policy on the new FK — Phase B is not the place
--   to change delete semantics (per QUA-549 non-goals).
--
-- Reverse migration (if needed):
--   ALTER TABLE resource_content_versions
--     DROP CONSTRAINT resource_content_versions_resource_id_resources_stable_id_fk;
--   UPDATE resource_content_versions rcv
--     SET resource_id = r.id
--     FROM resources r
--     WHERE rcv.resource_id = r.stable_id;
--   ALTER TABLE resource_content_versions
--     ADD CONSTRAINT resource_content_versions_resource_id_resources_id_fk
--     FOREIGN KEY (resource_id) REFERENCES resources(id)
--     ON DELETE SET NULL;

-- Step 1: drop the existing FK on resources.id.
-- Both the Drizzle-generated name (*_fk) and the postgres-default name (*_fkey)
-- can exist in prod due to historical migration paths; drop both. This pattern
-- was missed in the pilot and caused a deploy halt when prod had *_fkey
-- pointing at resources(id) — the Step 2 UPDATE tripped that surviving FK.
-- Every subsequent Phase B migration (0188, 0189, 0191, 0192, 0193, 0194, 0197)
-- drops both names; backporting the pattern here.
ALTER TABLE resource_content_versions
  DROP CONSTRAINT IF EXISTS resource_content_versions_resource_id_resources_id_fk;
ALTER TABLE resource_content_versions
  DROP CONSTRAINT IF EXISTS resource_content_versions_resource_id_fkey;

-- Step 2: rewrite resource_id values from hex16 → sid_<10> via JOIN.
-- Rows where resource_id IS NULL are untouched. Rows whose resource_id is
-- already a sid_<10> (shouldn't exist today, but defensive) are left alone
-- because the JOIN misses them.
UPDATE resource_content_versions rcv
SET resource_id = r.stable_id
FROM resources r
WHERE rcv.resource_id = r.id;

-- Step 3: verify no non-null resource_id values remain that don't match a
-- resources.stable_id. The pre-flight enumeration (QUA-549) found 0 orphans,
-- but fail fast rather than silently nulling or letting ADD CONSTRAINT reject.
DO $$
DECLARE
  orphan_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO orphan_count
  FROM resource_content_versions rcv
  WHERE rcv.resource_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM resources r WHERE r.stable_id = rcv.resource_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-549 migration aborted: % resource_content_versions row(s) have a resource_id that maps to neither resources.id nor resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;

-- Step 4: add the new FK on resources.stable_id, preserving SET NULL.
ALTER TABLE resource_content_versions
  ADD CONSTRAINT resource_content_versions_resource_id_resources_stable_id_fk
  FOREIGN KEY (resource_id) REFERENCES resources(stable_id)
  ON DELETE SET NULL;

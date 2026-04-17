-- QUA-568 Phase B.5: migrate source_check_evidence.resource_id from
-- referencing resources.id (legacy hex16 / `kb-<hex16>`) to resources.stable_id
-- (canonical `sid_<10>`).
--
-- Part of Phase B (QUA-549) of the resources-FK migration plan designed in
-- QUA-498. This ticket is the "thorniest" of the 17 tables because the column
-- feeds the verdict UI via /api/sourcing/* and backs source-check coverage
-- dashboards (see QUA-568 body for the risk profile). It ships in its own PR
-- to contain the verdict-API regression surface.
--
-- Follows the exact pattern established by the Phase B pilot in migration
-- 0186_qua_549_rcv_resource_id_to_stable_id.sql (resource_content_versions).
--
-- Pre-flight (prod, 2026-04-17):
--   5,337 rows with non-null resource_id (per QUA-549 audit, 2026-04-16).
--   Sampled resource_id formats in prod: bare hex16 (e.g. 'aebe92781f2a19fb')
--     and `kb-<hex16>` (e.g. 'kb-237cf097d225e116') — both are valid
--     resources.id values (confirmed via GET /api/resources/<id>).
--   0 orphans per parent-ticket audit across all 17 Phase B tables.
--   Existing FK: source_check_evidence_resource_id_resources_id_fk
--     ON DELETE SET NULL (matches schema.ts line 1691-1693).
--   Preserve the SET NULL policy on the new FK — Phase B is not the place
--   to change delete semantics (per QUA-549 non-goals).
--
-- No route handler JOINs `source_check_evidence.resource_id` against
-- `resources` today — it is a pass-through column written by
-- POST /api/sourcing/evidence and auto-resolved by
-- crux/lib/sourcing/verdict-handler.ts::storeSourcingEvidence (via
-- lookupResourceByUrl). That helper is updated in the same PR to read
-- `resource.stableId` instead of `resource.id` so new evidence writes
-- use the sid_ form.
--
-- Reverse migration (if needed):
--   ALTER TABLE source_check_evidence
--     DROP CONSTRAINT source_check_evidence_resource_id_resources_stable_id_fk;
--   UPDATE source_check_evidence sce
--     SET resource_id = r.id
--     FROM resources r
--     WHERE sce.resource_id = r.stable_id;
--   ALTER TABLE source_check_evidence
--     ADD CONSTRAINT source_check_evidence_resource_id_resources_id_fk
--     FOREIGN KEY (resource_id) REFERENCES resources(id)
--     ON DELETE SET NULL;

-- Step 1: drop the existing FK on resources.id.
-- IF EXISTS silences on re-runs. Both possible names are handled because
-- the phase1-sourcing-rename-rollback.sql history shows the constraint
-- may previously have been named `sourcing_evidence_resource_id_fkey`.
ALTER TABLE source_check_evidence
  DROP CONSTRAINT IF EXISTS source_check_evidence_resource_id_resources_id_fk;
ALTER TABLE source_check_evidence
  DROP CONSTRAINT IF EXISTS source_check_evidence_resource_id_fkey;

-- Step 2: rewrite resource_id values from hex16 / `kb-<hex16>` → sid_<10>
-- via JOIN on resources. Rows where resource_id IS NULL are untouched.
-- Rows whose resource_id is already a sid_<10> (shouldn't exist today,
-- but defensive for dev/staging replays) are left alone because the JOIN
-- misses them.
--
-- Batching: at 5,337 rows this is well within statement_timeout. Parent
-- ticket QUA-549 suggested the DO $$ LOOP batching pattern is only needed
-- for tables > 1M rows; we follow the single-statement approach from the
-- pilot migration 0186 (which handled 52 rows — same shape, different scale).
UPDATE source_check_evidence sce
SET resource_id = r.stable_id
FROM resources r
WHERE sce.resource_id = r.id;

-- Step 3: verify no non-null resource_id values remain that don't map to a
-- resources.stable_id. Pre-flight enumeration (QUA-549) found 0 orphans,
-- but fail fast rather than silently letting ADD CONSTRAINT reject at
-- migration time — that would block the whole deploy.
DO $$
DECLARE
  orphan_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO orphan_count
  FROM source_check_evidence sce
  WHERE sce.resource_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM resources r WHERE r.stable_id = sce.resource_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-568 migration aborted: % source_check_evidence row(s) have a resource_id that maps to neither resources.id nor resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;

-- Step 4: add the new FK on resources.stable_id, preserving SET NULL.
ALTER TABLE source_check_evidence
  ADD CONSTRAINT source_check_evidence_resource_id_resources_stable_id_fk
  FOREIGN KEY (resource_id) REFERENCES resources(stable_id)
  ON DELETE SET NULL;

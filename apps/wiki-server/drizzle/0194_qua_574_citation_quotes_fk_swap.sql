-- QUA-574 Phase B.2b: swap citation_quotes.resource_id reference from
-- resources.id → resources.stable_id.
--
-- Part of QUA-549 Phase B (17-table FK migration). Follows the in-place /
-- Option B pattern established in QUA-564 (0187), QUA-565 (0188), and
-- QUA-567 (0189): column name stays `resource_id`, the values are rewritten
-- in-place from hex16 → sid_, and only the `.references()` target in
-- schema.ts changes.
--
-- Prod state at time of authoring (2026-04-17, from QUA-574 ticket):
--   - 109 rows in citation_quotes with a non-null resource_id
--   - soft ref: NO FK constraint in prod (schema declares SET NULL only)
--   - resources.stable_id is 100% populated per QUA-536
--
-- Non-goal per QUA-549 / QUA-574: do NOT add the missing FK constraint on
-- citation_quotes.resource_id. Tracked separately. This migration only
-- realigns the stored values with the new schema reference target.

-- ────────────────────────────────────────────────────────────────────────
-- Defensive: drop any FK that may exist in dev/staging environments (prod
-- has none). Idempotent via IF EXISTS on both the Drizzle-generated name
-- and the postgres default (<table>_<column>_fkey). No-op in prod.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE "citation_quotes" DROP CONSTRAINT IF EXISTS "citation_quotes_resource_id_resources_id_fk";--> statement-breakpoint
ALTER TABLE "citation_quotes" DROP CONSTRAINT IF EXISTS "citation_quotes_resource_id_fkey";--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- Backfill: rewrite hex16 resource_id values to the corresponding sid_
-- value via JOIN on resources. Guarded by NOT LIKE 'sid_%' so re-runs
-- and already-migrated environments are no-ops. The r.stable_id IS NOT
-- NULL guard prevents silently overwriting a real link with NULL if some
-- resources row is missing its stable_id.
-- ────────────────────────────────────────────────────────────────────────
UPDATE "citation_quotes" cq
SET resource_id = r.stable_id
FROM "resources" r
WHERE cq.resource_id = r.id
  AND cq.resource_id IS NOT NULL
  AND cq.resource_id NOT LIKE 'sid_%'
  AND r.stable_id IS NOT NULL;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────
-- Soft-ref orphan check + diagnostics. After the backfill, every non-null
-- resource_id should either already be in sid_ form or be an orphan
-- (no matching resources row). We do NOT raise here — citation_quotes is
-- a soft ref, so some orphans are acceptable (the schema's ON DELETE
-- SET NULL is not enforced without a real FK). Instead, emit NOTICEs so
-- operators can investigate post-deploy. This is a deliberate difference
-- from the hard-FK migrations (0187/0188/0189) which must halt on
-- orphans to avoid a failed ADD CONSTRAINT.
--
-- Two distinct diagnostic counters:
--   (a) total post-backfill orphans — any non-null resource_id with no
--       matching resources.stable_id. Expected to be 0 in prod.
--   (b) rows that could not be backfilled because the matching resources
--       row had NULL stable_id. Expected to be 0 per QUA-536 (100%
--       populated), but called out separately so the root cause is
--       visible if either category turns up.
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  orphan_count INT;
  skipped_null_stableid INT;
BEGIN
  -- Single scan computes both counters. `skipped_null_stableid` is the
  -- specific subset of rows that would have been backfilled except the
  -- matching resources row has a NULL stable_id — fixable by populating
  -- resources.stable_id (see QUA-536), then re-running.
  SELECT
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM resources r WHERE r.stable_id = cq.resource_id
      )
    ),
    COUNT(*) FILTER (
      WHERE cq.resource_id NOT LIKE 'sid_%'
        AND EXISTS (
          SELECT 1 FROM resources r
          WHERE r.id = cq.resource_id AND r.stable_id IS NULL
        )
    )
    INTO orphan_count, skipped_null_stableid
  FROM citation_quotes cq
  WHERE cq.resource_id IS NOT NULL;

  IF skipped_null_stableid > 0 THEN
    RAISE NOTICE 'QUA-574: % citation_quotes row(s) could not be backfilled because the matching resources row has a NULL stable_id. Populate resources.stable_id for those rows (see QUA-536) and re-run this migration to complete.', skipped_null_stableid;
  END IF;

  IF orphan_count > 0 THEN
    RAISE NOTICE 'QUA-574: % citation_quotes row(s) have a resource_id with no matching resources.stable_id after backfill. Soft ref — not halting. Investigate via `SELECT id, page_id, footnote, resource_id FROM citation_quotes WHERE resource_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.stable_id = citation_quotes.resource_id);`.', orphan_count;
  END IF;
END $$;

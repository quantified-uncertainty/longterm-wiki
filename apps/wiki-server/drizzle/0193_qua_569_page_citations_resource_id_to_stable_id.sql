-- QUA-569 Phase B.6: migrate page_citations.resource_id from referencing
-- resources.id (legacy hex16) to resources.stable_id (canonical `sid_<10>`),
-- AND reconcile the duplicate FK on that column.
--
-- Part of Phase B (QUA-549) of the resources-FK migration plan designed in
-- QUA-498. This ticket is separated from the bulk phases because the column
-- currently has TWO FK constraints with different onDelete semantics:
--
--   page_citations_resource_id_fkey              FK → resources(id)  [NO ACTION]
--   page_citations_resource_id_resources_id_fk   FK → resources(id)  [SET NULL]
--
-- Parent ticket QUA-549 explicitly non-goals any duplicate-FK cleanup; this
-- migration IS the reconciliation. Both legacy constraints are dropped and
-- replaced with a single FK to resources.stable_id with ON DELETE SET NULL
-- (preserves the SET NULL declared in schema.ts since migration 0064, which
-- is what any caller already behaviorally depended on — NO ACTION was the
-- Drizzle auto-generated default from the original inline REFERENCES at
-- migration 0033 and was never the intended policy; see migration 0064 and
-- 0168 for the SET NULL audit trail).
--
-- Pre-flight (prod, 2026-04-18):
--   5,021 total rows; 105 with non-null resource_id, 4,916 with NULL.
--   All 105 non-null values are legacy hex16/kb- form (0 already-sid_).
--   0 orphans: every non-null resource_id maps cleanly to a resources row
--     with a populated stable_id.
--
-- Reverse migration (if needed):
--   ALTER TABLE page_citations
--     DROP CONSTRAINT page_citations_resource_id_resources_stable_id_fk;
--   UPDATE page_citations pc
--     SET resource_id = r.id
--     FROM resources r
--     WHERE pc.resource_id = r.stable_id;
--   ALTER TABLE page_citations
--     ADD CONSTRAINT page_citations_resource_id_resources_id_fk
--     FOREIGN KEY (resource_id) REFERENCES resources(id)
--     ON DELETE SET NULL;
--   -- The original `_fkey` constraint (NO ACTION) is NOT restored: it was
--   -- a duplicate with no runtime semantics beyond what SET NULL already
--   -- provides, and re-introducing it just recreates the debt QUA-569 paid.

-- Step 1: drop BOTH existing FKs on resources.id.
-- The pair was introduced at different points in the schema history:
--   migration 0033 (original pageCitations table with inline REFERENCES →
--     auto-named `page_citations_resource_id_fkey`, NO ACTION semantics)
--   migration 0064 (explicit re-add under the Drizzle-canonical name
--     `page_citations_resource_id_resources_id_fk` with SET NULL semantics)
-- IF EXISTS silences on replays. All three possible names are included to
-- cover any dev/staging environment where the older `_fkey` may have been
-- manually cleaned up (or where Drizzle normalized one of them differently).
ALTER TABLE page_citations
  DROP CONSTRAINT IF EXISTS page_citations_resource_id_resources_id_fk;
ALTER TABLE page_citations
  DROP CONSTRAINT IF EXISTS page_citations_resource_id_fkey;

-- Defensive sanity check: after the DROPs, no FK on resource_id should remain
-- pointing at resources.id. If one does, the pg_constraint name drifted beyond
-- the two legacy variants we know about — fail loudly before the UPDATE
-- violates it, rather than letting the migration half-apply. (Same pattern as
-- migration 0191 for source_check_evidence.)
DO $$
DECLARE
  remaining_fk TEXT;
BEGIN
  SELECT conname INTO remaining_fk
  FROM pg_constraint
  WHERE conrelid = 'page_citations'::regclass
    AND contype = 'f'
    AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                       WHERE attrelid = 'page_citations'::regclass
                         AND attname = 'resource_id')]
    AND confrelid = 'resources'::regclass
    AND confkey = ARRAY[(SELECT attnum FROM pg_attribute
                        WHERE attrelid = 'resources'::regclass
                          AND attname = 'id')]
  LIMIT 1;
  IF remaining_fk IS NOT NULL THEN
    RAISE EXCEPTION 'QUA-569 migration aborted: unexpected FK constraint "%" still points page_citations.resource_id at resources.id after DROP attempts. Add an explicit DROP for this name and re-run.', remaining_fk;
  END IF;
END $$;

-- Step 2: rewrite resource_id values from hex16 → sid_<10> via JOIN on resources.
-- Rows where resource_id IS NULL are untouched (the JOIN misses them).
-- Rows whose resource_id is already a sid_<10> (shouldn't exist today, but
-- defensive for dev/staging replays) are also left alone because the JOIN
-- against resources.id misses them.
--
-- At 105 non-null rows this is a trivial single statement; no batching needed.
UPDATE page_citations pc
SET resource_id = r.stable_id
FROM resources r
WHERE pc.resource_id = r.id;

-- Step 3: verify no non-null resource_id remains that doesn't map to a
-- resources.stable_id. Pre-flight found 0 orphans, but fail fast rather than
-- silently letting ADD CONSTRAINT reject at migration time — that would block
-- the whole deploy.
DO $$
DECLARE
  orphan_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO orphan_count
  FROM page_citations pc
  WHERE pc.resource_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM resources r WHERE r.stable_id = pc.resource_id
    );
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'QUA-569 migration aborted: % page_citations row(s) have a resource_id that maps to neither resources.id nor resources.stable_id. Investigate before re-running.', orphan_count;
  END IF;
END $$;

-- Step 4: add the new single FK on resources.stable_id, preserving SET NULL.
-- The duplicate constraint from before is NOT recreated — this migration is
-- the explicit reconciliation per QUA-569.
ALTER TABLE page_citations
  ADD CONSTRAINT page_citations_resource_id_resources_stable_id_fk
  FOREIGN KEY (resource_id) REFERENCES resources(stable_id)
  ON DELETE SET NULL;

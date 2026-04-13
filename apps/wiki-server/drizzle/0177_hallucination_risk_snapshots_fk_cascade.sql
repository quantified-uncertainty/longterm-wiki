-- QUA-352: Add ON DELETE CASCADE to hallucination_risk_snapshots.page_id FK.
--
-- When a wiki_pages row is deleted/renamed, the corresponding snapshot rows
-- became orphans because the existing FK (added in 0026) had no ON DELETE
-- action on the current integer page_id column. Each orphan page_id becomes
-- its own retention partition and accumulates up to `keep` rows that cleanup
-- never reaps, driving unbounded growth (3.3M rows / 905 MB on prod,
-- ~47× the ~70K target).
--
-- The table is ~900 MB on prod, which triggered the QUA-302 incident on
-- 2026-04-11 (migration 0173 held ACCESS EXCLUSIVE for ~12h while fighting the
-- hallucination_risk_latest matview refresh). This migration MUST use the
-- NOT VALID pattern per `.claude/rules/database-migrations.md` so that:
--   - DROP + ADD NOT VALID only hold ACCESS EXCLUSIVE for milliseconds
--     (no table scan), so the deploy PreSync completes cleanly.
--   - VALIDATE CONSTRAINT is deferred to a follow-up manual script that runs
--     AFTER the Phase 2 one-shot orphan cleanup, since VALIDATE would fail
--     against the existing orphans. See
--     `apps/wiki-server/scripts/validate-hallucination-risk-snapshots-fk.sql`.
--
-- Once this migration lands, NEW inserts and updates to page_id are enforced
-- against wiki_pages (NOT VALID only skips the check on existing rows). Any
-- deletion of a wiki_pages row will cascade to its snapshot rows, so the
-- orphan-page_id class of growth cannot recur.

-- Phase 1a: drop whatever FK currently references wiki_pages from the
-- page_id column, by looking it up dynamically. The constraint name may be
-- the original from 0026 (`hallucination_risk_snapshots_page_id_wiki_pages_id_fk`),
-- a Drizzle-generated variant, or absent entirely after past column renames /
-- PK swaps. Milliseconds of ACCESS EXCLUSIVE.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid
                         AND att.attnum = ANY(con.conkey)
    WHERE con.contype = 'f'
      AND rel.relname = 'hallucination_risk_snapshots'
      AND att.attname = 'page_id'
      AND array_length(con.conkey, 1) = 1
  LOOP
    EXECUTE format(
      'ALTER TABLE "hallucination_risk_snapshots" DROP CONSTRAINT IF EXISTS %I',
      r.conname
    );
    RAISE NOTICE 'Dropped FK hallucination_risk_snapshots.%', r.conname;
  END LOOP;
END $$;

-- Phase 1b: belt-and-suspenders — also drop the canonical name in case it
-- somehow survived under a lookup path the pg_constraint query above missed.
ALTER TABLE "hallucination_risk_snapshots"
  DROP CONSTRAINT IF EXISTS "hallucination_risk_snapshots_page_id_wiki_pages_id_fk";

-- Phase 2: add the new constraint with CASCADE, NOT VALID so the validation
-- scan is skipped. Milliseconds of ACCESS EXCLUSIVE. New inserts and updates
-- are enforced from this point on.
ALTER TABLE "hallucination_risk_snapshots"
  ADD CONSTRAINT "hallucination_risk_snapshots_page_id_wiki_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "wiki_pages"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION
  NOT VALID;

-- VALIDATE CONSTRAINT is INTENTIONALLY NOT run here. The table currently
-- contains orphan rows (snapshots whose page_id no longer exists in
-- wiki_pages) — VALIDATE would scan and error on the first orphan. The
-- orphan cleanup is scheduled as a post-deploy manual step (Phase 2 of
-- QUA-352), and then `scripts/validate-hallucination-risk-snapshots-fk.sql`
-- runs the VALIDATE separately.

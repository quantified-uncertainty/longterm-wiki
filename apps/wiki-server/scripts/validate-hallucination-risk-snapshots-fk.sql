-- QUA-352: Validate the NOT VALID FK constraint on
-- hallucination_risk_snapshots.page_id added by Drizzle migration 0177.
--
-- Run this AFTER the Phase 2 orphan cleanup has deleted all snapshot rows
-- whose page_id no longer exists in wiki_pages. VALIDATE CONSTRAINT only
-- takes SHARE UPDATE EXCLUSIVE, so concurrent reads, writes, and matview
-- refreshes proceed normally.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/validate-hallucination-risk-snapshots-fk.sql
--
-- Safe to re-run: the validation is idempotent, and the NOT EXISTS guard
-- aborts cleanly if the FK was already validated (convalidated = true) so
-- reruns don't take a lock unnecessarily.

DO $$
DECLARE
  is_valid boolean;
BEGIN
  SELECT convalidated INTO is_valid
  FROM pg_constraint
  WHERE conname = 'hallucination_risk_snapshots_page_id_wiki_pages_id_fk';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'FK hallucination_risk_snapshots_page_id_wiki_pages_id_fk not found — '
      'migration 0177 may not have been applied yet.';
  END IF;

  IF is_valid THEN
    RAISE NOTICE 'FK already validated — no-op.';
    RETURN;
  END IF;

  -- Pre-flight check: look for remaining orphans and fail with a useful
  -- message if any exist, instead of letting VALIDATE fail with a generic
  -- row-reference error. This tells the operator exactly how many rows need
  -- to be cleaned up before the validation can proceed.
  PERFORM 1 FROM hallucination_risk_snapshots hrs
    LEFT JOIN wiki_pages wp ON wp.id = hrs.page_id
    WHERE hrs.page_id IS NOT NULL AND wp.id IS NULL
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Orphan hallucination_risk_snapshots rows still exist. Run the QUA-352 '
      'Phase 2 cleanup DELETE before validating this FK.';
  END IF;

  ALTER TABLE hallucination_risk_snapshots
    VALIDATE CONSTRAINT hallucination_risk_snapshots_page_id_wiki_pages_id_fk;

  RAISE NOTICE 'FK hallucination_risk_snapshots_page_id_wiki_pages_id_fk validated.';
END $$;

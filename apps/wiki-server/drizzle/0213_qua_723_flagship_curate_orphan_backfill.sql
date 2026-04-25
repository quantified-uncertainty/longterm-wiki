-- QUA-723: Backfill flagship-curate reset orphans.
--
-- `crux flagship-curate` previously wrote `unchecked` reset verdicts with
-- `needs_recheck=false` and `next_check_due=NULL`, so the weekly
-- `sourcing-recheck` cron skipped them permanently. The code path is fixed
-- in this PR (set both fields on every reset write), but existing orphan
-- rows need a one-shot rescue so the next cron run picks them up.
--
-- Match criteria (exact match on the single literal written by
-- crux/commands/flagship-curate.ts::resetStaleVerdicts — substring
-- ILIKE would risk colliding with LLM-generated reasoning text from
-- other source-check writers, which can be up to 5000 chars):
--   - reasoning = 'Reset by flagship-curate before re-verification'
--   - verdict   = 'unchecked'
--   - next_check_due IS NULL  (only the orphans, not rows that already
--                              have a recheck scheduled)
--
-- Idempotent: safe to re-run; the WHERE clause excludes any row whose
-- next_check_due has already been backfilled.

DO $$
DECLARE
  rows_updated INT;
BEGIN
  UPDATE "source_check_verdicts"
  SET
    "needs_recheck" = true,
    "next_check_due" = NOW(),
    "updated_at" = NOW()
  WHERE "reasoning" = 'Reset by flagship-curate before re-verification'
    AND "verdict" = 'unchecked'
    AND "next_check_due" IS NULL;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE 'QUA-723 backfill: re-armed % flagship-curate reset orphan(s)', rows_updated;
END $$;

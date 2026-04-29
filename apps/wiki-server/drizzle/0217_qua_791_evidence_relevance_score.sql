-- QUA-791 Phase 1: server-side relevance-weighted verdict aggregation.
--
-- Adds `relevance_score` column to `source_check_evidence`. Used as a
-- weight when aggregating evidence rows into a single
-- `source_check_verdicts` row.
--
-- NULL keeps existing rows participating at full weight (treated as 1.0
-- by the aggregator) until the relevance gate (QUA-426) backfills
-- realistic scores. The relevance gate itself short-circuits to
-- verdict='not_applicable' for pages that don't mention the subject —
-- those rows are dropped entirely by the aggregation rule.
--
-- Range is intended to be 0..1 but NOT enforced by CHECK constraint at
-- this stage; callers may persist nulls (then treated as 1.0 in the
-- aggregator). A CHECK can be added in a follow-up once all writers
-- populate the column.

ALTER TABLE "source_check_evidence"
  ADD COLUMN IF NOT EXISTS "relevance_score" real;

-- Backfill not_applicable rows to relevance_score = 0.
--
-- The aggregator currently drops not_applicable rows entirely (step 1
-- of the rule), so a NULL score on existing rows is moot. But
-- `item-verifier.ts` writes `relevanceScore: 0` for not_applicable
-- rows on the going-forward path as a "belt + suspenders" guard for
-- if the not_applicable filter is later relaxed. Without backfilling
-- existing rows the guarantee only holds for newly-written evidence.
-- Cheap one-shot UPDATE — typical not_applicable count is bounded by
-- the relevance-gate hit rate (~tens of thousands rows max).
UPDATE "source_check_evidence"
   SET "relevance_score" = 0
 WHERE "verdict" = 'not_applicable'
   AND "relevance_score" IS NULL;

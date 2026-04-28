-- QUA-791 Phase 1: server-side relevance-weighted verdict aggregation.
--
-- Adds `relevance_score` column to `source_check_evidence`. Used as a
-- weight when aggregating evidence rows into a single
-- `source_check_verdicts` row.
--
-- Default 1.0 keeps existing rows participating at full weight until the
-- relevance gate (QUA-426) backfills realistic scores. The relevance gate
-- itself short-circuits to verdict='not_applicable' for pages that don't
-- mention the subject — those rows are dropped entirely by the
-- aggregation rule and the score is moot for them.
--
-- Range is intended to be 0..1 but NOT enforced by CHECK constraint at
-- this stage; callers may persist nulls (then treated as 1.0 in the
-- aggregator). A CHECK can be added in a follow-up once all writers
-- populate the column.

ALTER TABLE "source_check_evidence"
  ADD COLUMN IF NOT EXISTS "relevance_score" real;

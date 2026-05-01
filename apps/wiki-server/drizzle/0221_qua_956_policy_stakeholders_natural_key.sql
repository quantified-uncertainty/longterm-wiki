-- QUA-956 (parent: QUA-943 v4 RFC §0f): natural-key + UNIQUE on policy_stakeholders.
--
-- Phase 0f pre-condition for the QUA-943 machine-write transition. Phase 3 of
-- that umbrella retries `enum_violation` failures with a corrected payload
-- against the same (policy, stakeholder) — without a UNIQUE constraint, each
-- retry mints a new id and the table accumulates duplicates. With UNIQUE
-- + ON CONFLICT (policy_entity_id, stakeholder_display_name) on the sync
-- route, a same-natural-key insert resolves as an upsert.
--
-- Mandatory enumeration (per .claude/rules/database-migrations.md "Adding
-- unique constraints" + "Adding CHECK constraints on enum columns"). Run
-- against prod 2026-04-30:
--
--   total_rows: 477
--   distinct_natural_keys: 243
--   duplicate_groups: 136
--   rows_to_delete: 234
--
-- Distribution: 107 unique groups + 38 doubles (38 dupes) + 98 triples (196
-- dupes) = 234 rows to delete.
--
-- Per-field divergence within duplicate groups (also enumerated 2026-04-30):
--   position:                  0 groups differ ✓
--   importance:                0 groups differ ✓
--   reason:                    0 groups differ ✓
--   stakeholder_entity_id:    62 groups differ — earliest is always NULL,
--                                a later duplicate carries the resolved sid_.
--                                Naive earliest-keep silently discards 62
--                                stakeholder→entity links.
--   source URL:                7 groups differ — 4 cases canonical has URL,
--                                3 cases both have different URLs (one
--                                non-canonical URL is dropped, acceptable).
--
-- Strategy: COALESCE-merge non-null fields from duplicates into the canonical
-- (earliest) row BEFORE deleting duplicates. The canonical id stays stable
-- (preserves source_check_verdicts/evidence pointers, and Phase 3 retry
-- semantics expect the original id to be re-found by natural key). Pattern
-- adapted from 0143_dedup_funding_program_unique.sql + 0108_natural_key_uniqueness.sql.

-- Step 1: Merge non-null fields from duplicates into the canonical row.
--
-- For each duplicate (policy_entity_id, stakeholder_display_name) group:
--   canonical = the row with earliest (created_at, id) — i.e., rn=1.
--   For each enrichable column, take the canonical's existing value if not
--     NULL/empty; otherwise take the latest non-null value across the group.
--
-- ORDER BY for the array_agg picks "non-null first, then most recent" so the
-- chosen merge value is the freshest enrichment available.
UPDATE policy_stakeholders ps
SET
  stakeholder_entity_id = COALESCE(ps.stakeholder_entity_id, m.merged_eid),
  source = COALESCE(NULLIF(ps.source, ''), m.merged_source),
  reason = COALESCE(NULLIF(ps.reason, ''), m.merged_reason),
  importance = COALESCE(ps.importance, m.merged_importance),
  context = COALESCE(ps.context, m.merged_context),
  updated_at = now()
FROM (
  SELECT
    policy_entity_id,
    stakeholder_display_name,
    (array_agg(id ORDER BY created_at, id))[1] AS canonical_id,
    (array_agg(stakeholder_entity_id ORDER BY (stakeholder_entity_id IS NULL), created_at DESC, id DESC) FILTER (WHERE stakeholder_entity_id IS NOT NULL))[1] AS merged_eid,
    (array_agg(source                 ORDER BY (source IS NULL),                created_at DESC, id DESC) FILTER (WHERE source IS NOT NULL AND source != ''))[1] AS merged_source,
    (array_agg(reason                 ORDER BY (reason IS NULL),                created_at DESC, id DESC) FILTER (WHERE reason IS NOT NULL AND reason != ''))[1] AS merged_reason,
    (array_agg(importance             ORDER BY (importance IS NULL),            created_at DESC, id DESC) FILTER (WHERE importance IS NOT NULL))[1] AS merged_importance,
    (array_agg(context                ORDER BY (context IS NULL),               created_at DESC, id DESC) FILTER (WHERE context IS NOT NULL))[1] AS merged_context
  FROM policy_stakeholders
  GROUP BY policy_entity_id, stakeholder_display_name
  HAVING COUNT(*) > 1
) m
WHERE ps.id = m.canonical_id;

-- Step 2: Delete things entries for the duplicate policy_stakeholders rows.
-- Each policy_stakeholders row has a paired things row (sourceTable =
-- 'policy_stakeholders', sourceId = policy_stakeholders.id) written by the
-- sync route's `toThing`. Drop the duplicates' things rows before the
-- parent rows so we don't leave dangling pointers. The canonical row's
-- things entry is preserved.
DELETE FROM things
WHERE source_table = 'policy_stakeholders'
  AND source_id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY policy_entity_id, stakeholder_display_name
        ORDER BY created_at, id
      ) AS rn
      FROM policy_stakeholders
    ) ranked WHERE rn > 1
  );

-- Step 3: Delete duplicate policy_stakeholders rows. Keep earliest-created
-- per (policy_entity_id, stakeholder_display_name); id is the deterministic
-- tiebreaker for rows that share created_at. Step 1 has already merged any
-- non-null enrichment from these rows into the canonical, so this is a
-- pure "drop the now-redundant copies" delete.
--
-- No FK references to policy_stakeholders.id exist in the schema (verified
-- 2026-04-30 via information_schema), so this is safe without further
-- cascade work. source_check_verdicts / source_check_evidence /
-- sourcing_url_suggestions rows that pointed to deleted ids become
-- orphans; they remain queryable but no longer match a live record.
-- The canonical row's existing verdicts are unchanged (its id is stable).
-- A post-merge re-source-check would write a fresh verdict for any
-- columns that gained data in Step 1; the orphans can be swept in a
-- separate ticket.
DELETE FROM policy_stakeholders
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY policy_entity_id, stakeholder_display_name
      ORDER BY created_at, id
    ) AS rn
    FROM policy_stakeholders
  ) ranked WHERE rn > 1
);

-- Step 4: Add the natural-key UNIQUE index. Both columns are NOT NULL in
-- the schema so a partial index isn't required. IF NOT EXISTS keeps replays
-- idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_stakeholders_natural_key
  ON policy_stakeholders (policy_entity_id, stakeholder_display_name);

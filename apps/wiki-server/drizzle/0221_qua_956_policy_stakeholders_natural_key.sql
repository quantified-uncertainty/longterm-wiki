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
-- Pattern: dynamic ROW_NUMBER dedup (same shape as 0143_dedup_funding_program_unique
-- and 0108_natural_key_uniqueness). Hardcoding ids would miss new duplicates
-- created between PR open and merge — see the 2026-03-28 funding_programs
-- outage for what that costs.

-- Step 1: Delete things entries for the duplicate policy_stakeholders rows.
-- Each policy_stakeholders row has a paired things row (sourceTable =
-- 'policy_stakeholders', sourceId = policy_stakeholders.id) written by the
-- sync route's `toThing`. Drop those before the parent rows so we don't
-- leave dangling pointers.
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

-- Step 2: Delete duplicate policy_stakeholders rows. Keep earliest-created
-- per (policy_entity_id, stakeholder_display_name); id is the deterministic
-- tiebreaker for rows that share created_at.
--
-- No FK references to policy_stakeholders.id exist in the schema (verified
-- 2026-04-30 via information_schema), so this is safe without further
-- cascade work. source_check_verdicts / source_check_evidence /
-- sourcing_url_suggestions rows that pointed to deleted ids become
-- orphans; they remain queryable but no longer match a live record.
-- Re-source-checking the canonical row writes a fresh verdict; the
-- orphans can be swept in a separate ticket.
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

-- Step 3: Add the natural-key UNIQUE index. Both columns are NOT NULL in
-- the schema so a partial index isn't required. IF NOT EXISTS keeps replays
-- idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_stakeholders_natural_key
  ON policy_stakeholders (policy_entity_id, stakeholder_display_name);

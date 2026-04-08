-- Epic #4017 Phase B3 (narrowed): Add unique index on policy_stakeholders
-- natural key.
--
-- The original B3 PR (#4032) was closed because the grants and funding_rounds
-- natural keys were wrong (name collisions across years). This migration only
-- covers policy_stakeholders, where the natural key IS correct:
-- (policy_entity_id, stakeholder_display_name, position) — all NOT NULL,
-- genuinely unique per policy + stakeholder + position taken.
--
-- Pattern: ROW_NUMBER() dynamic dedup (keeps most-recently-updated row),
-- then CREATE UNIQUE INDEX IF NOT EXISTS. Reference: migration 0108.

-- ============================================================================
-- Step 1: Deduplicate existing rows
-- ============================================================================

DELETE FROM policy_stakeholders
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY policy_entity_id, stakeholder_display_name, position
        ORDER BY
          (CASE WHEN stakeholder_entity_id IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN importance IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN reason IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN context IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM policy_stakeholders
  ) ranked
  WHERE rn > 1
);

-- ============================================================================
-- Step 2: Add unique index
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_stakeholders_natural_key
  ON policy_stakeholders (policy_entity_id, stakeholder_display_name, position);

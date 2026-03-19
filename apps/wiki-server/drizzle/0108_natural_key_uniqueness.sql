-- Add composite unique constraints on natural keys to prevent duplicate records.
-- Tables are small (personnel ~230, investments ~56, division_personnel ~0)
-- so no manual migration needed.

-- ============================================================================
-- Step 1: Deduplicate existing rows (keep the most recently updated record)
-- ============================================================================

-- Personnel: deduplicate on (person_entity_id, org_entity_id, role_type, role)
-- Only considers rows where both entity IDs are resolved (non-null).
-- Keeps the row with the most non-null fields; breaks ties by updated_at DESC.
DELETE FROM personnel
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY person_entity_id, org_entity_id, role_type, role
        ORDER BY
          -- Prefer rows with more non-null optional fields
          (CASE WHEN start_date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN end_date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN appointed_by IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN background IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN person_display_name IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN org_display_name IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM personnel
    WHERE person_entity_id IS NOT NULL
      AND org_entity_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Division personnel: deduplicate on (division_id, person_id)
DELETE FROM division_personnel
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY division_id, person_id
        ORDER BY
          (CASE WHEN start_date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN end_date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM division_personnel
  ) ranked
  WHERE rn > 1
);

-- Investments: deduplicate on (investor_entity_id, company_entity_id, COALESCE(round_name, ''))
-- Only considers rows where both entity IDs are resolved (non-null).
DELETE FROM investments
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY investor_entity_id, company_entity_id, COALESCE(round_name, '')
        ORDER BY
          (CASE WHEN date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN stake_acquired IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN instrument IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN role IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN conditions IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN investor_display_name IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN company_display_name IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM investments
    WHERE investor_entity_id IS NOT NULL
      AND company_entity_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- ============================================================================
-- Step 2: Add unique constraints via partial indexes
-- ============================================================================

-- Personnel: unique on (person_entity_id, org_entity_id, role_type, role)
-- Partial: only enforced when all entity IDs are resolved.
-- Uses role (specific title) not just role_type, because a person can hold
-- multiple distinct roles of the same type at one org (e.g. Executive Director
-- then President, both key-person).
CREATE UNIQUE INDEX IF NOT EXISTS uq_personnel_natural_key
  ON personnel (person_entity_id, org_entity_id, role_type, role)
  WHERE person_entity_id IS NOT NULL AND org_entity_id IS NOT NULL;

-- Division personnel: unique on (division_id, person_id)
-- Both columns are NOT NULL, so no partial index needed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_division_personnel_natural_key
  ON division_personnel (division_id, person_id);

-- Investments: unique on (investor_entity_id, company_entity_id, round_name)
-- Uses COALESCE for round_name since it can be null (treats null as '').
-- Partial: only enforced when entity IDs are resolved.
CREATE UNIQUE INDEX IF NOT EXISTS uq_investments_natural_key
  ON investments (investor_entity_id, company_entity_id, COALESCE(round_name, ''))
  WHERE investor_entity_id IS NOT NULL AND company_entity_id IS NOT NULL;

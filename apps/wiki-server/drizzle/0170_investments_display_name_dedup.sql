-- Fix #3353: Deduplicate investment rows and strengthen the unique constraint.
--
-- Problem: The existing partial unique index (uq_investments_natural_key) only
-- enforces uniqueness when BOTH investor_entity_id AND company_entity_id are
-- resolved (non-null). Unresolved YC variants (e.g. "Y Combinator" vs
-- "y-combinator") bypass the constraint and create duplicate rows.
--
-- Solution:
-- 1. Deduplicate using display-name-based grouping (covers both resolved and
--    unresolved rows).
-- 2. Drop the old partial index.
-- 3. Create a new NON-partial unique index on
--    (LOWER(COALESCE(investor_display_name, investor_id)),
--     LOWER(COALESCE(company_display_name, company_id)),
--     LOWER(COALESCE(round_name, '')))
--    This covers ALL rows, not just those with resolved entity IDs.

-- ============================================================================
-- Step 1: Deduplicate existing rows using display-name grouping.
-- Keeps the row with the most non-null fields; ties broken by updated_at DESC.
-- Uses ROW_NUMBER() window function — NEVER hardcode specific IDs.
-- ============================================================================

DELETE FROM investments
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          LOWER(COALESCE(investor_display_name, investor_id)),
          LOWER(COALESCE(company_display_name, company_id)),
          LOWER(COALESCE(round_name, ''))
        ORDER BY
          -- Prefer rows with resolved entity IDs
          (CASE WHEN investor_entity_id IS NOT NULL THEN 10 ELSE 0 END
           + CASE WHEN company_entity_id IS NOT NULL THEN 10 ELSE 0 END
           -- Then prefer rows with more non-null optional fields
           + CASE WHEN date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN stake_acquired IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN instrument IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN role IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN conditions IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM investments
  ) ranked
  WHERE rn > 1
);

-- Also clean up orphaned things rows for deleted investments
DELETE FROM things
WHERE source_table = 'investments'
  AND source_id NOT IN (SELECT id FROM investments);

-- ============================================================================
-- Step 2: Drop the old partial unique index and create a stronger one.
-- ============================================================================

DROP INDEX IF EXISTS uq_investments_natural_key;

-- New index covers ALL rows (not partial), using display names as the grouping
-- key. This prevents duplicates regardless of entity resolution status.
CREATE UNIQUE INDEX IF NOT EXISTS uq_investments_display_name_key
  ON investments (
    LOWER(COALESCE(investor_display_name, investor_id)),
    LOWER(COALESCE(company_display_name, company_id)),
    LOWER(COALESCE(round_name, ''))
  );

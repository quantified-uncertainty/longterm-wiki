-- Epic #4017 Phase B3: Add unique indexes on natural keys for grants,
-- funding_rounds, and policy_stakeholders.
--
-- These tables use `id` as the upsert conflict target, which provides no
-- natural-key deduplication. Concurrent or repeated syncs can create
-- duplicate rows that the application thinks were prevented.
--
-- Pattern: ROW_NUMBER() dynamic dedup (keeps most-recently-updated row),
-- then CREATE UNIQUE INDEX IF NOT EXISTS. Reference: migration 0108.
--
-- Tables are moderate size (grants ~2000, funding_rounds ~200,
-- policy_stakeholders ~500) so ALTER TABLE is fast and doesn't need
-- a manual migration.

-- ============================================================================
-- Step 1: Deduplicate existing rows
-- ============================================================================

-- Grants: deduplicate on (organization_id, name)
-- Two grants are duplicates if they belong to the same org and share a name.
-- Keep the row with the most non-null optional fields; break ties by updated_at.
DELETE FROM grants
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY organization_id, name
        ORDER BY
          (CASE WHEN amount IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN period IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN status IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN program_id IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN org_entity_id IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN grantee_entity_id IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM grants
  ) ranked
  WHERE rn > 1
);

-- Funding rounds: deduplicate on (company_id, name)
-- Two rounds are duplicates if they belong to the same company and share a name.
DELETE FROM funding_rounds
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY company_id, name
        ORDER BY
          (CASE WHEN date IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN raised IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN valuation IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN instrument IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN lead_investor IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN notes IS NOT NULL THEN 1 ELSE 0 END
           + CASE WHEN company_entity_id IS NOT NULL THEN 1 ELSE 0 END
          ) DESC,
          updated_at DESC,
          created_at DESC
      ) AS rn
    FROM funding_rounds
  ) ranked
  WHERE rn > 1
);

-- Policy stakeholders: deduplicate on (policy_entity_id, stakeholder_display_name, position)
-- A stakeholder record is logically unique per policy + stakeholder name + position.
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
-- Step 2: Add unique indexes
-- ============================================================================

-- Grants: unique on (organization_id, name)
-- Both columns are NOT NULL, so no partial index needed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_grants_natural_key
  ON grants (organization_id, name);

-- Funding rounds: unique on (company_id, name)
-- Both columns are NOT NULL, so no partial index needed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_funding_rounds_natural_key
  ON funding_rounds (company_id, name);

-- Policy stakeholders: unique on (policy_entity_id, stakeholder_display_name, position)
-- All three columns are NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_stakeholders_natural_key
  ON policy_stakeholders (policy_entity_id, stakeholder_display_name, position);

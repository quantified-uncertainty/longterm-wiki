-- Migrate facts.entity_id and facts.subject from entity slugs to stable IDs.
-- This is part of the unified ID migration (Discussion #2169).
--
-- Pre-conditions:
--   - entities.stable_id is populated for all entities referenced by facts
--   - entity_ids.stable_id backfill has been run
--
-- With only ~145 facts in production, this runs in milliseconds.

-- Step 1: Delete orphaned facts (entities that no longer exist).
-- These are already dangling FK violations flagged by the integrity check.
DELETE FROM facts
WHERE entity_id NOT IN (SELECT id FROM entities);

-- Step 2: Drop existing FK constraints (they reference entities.id = slug).
ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_entity_id_entities_id_fk";
ALTER TABLE "facts" DROP CONSTRAINT IF EXISTS "facts_subject_entities_id_fk";

-- Step 3: Convert entity_id from slug to stable_id.
UPDATE facts
SET entity_id = e.stable_id
FROM entities e
WHERE facts.entity_id = e.id
  AND e.stable_id IS NOT NULL;

-- Step 4: Convert subject from slug to stable_id (nullable column).
UPDATE facts
SET subject = e.stable_id
FROM entities e
WHERE facts.subject = e.id
  AND e.stable_id IS NOT NULL;

-- Step 5: Add new FK constraints referencing entities.stable_id.
ALTER TABLE "facts"
  ADD CONSTRAINT "facts_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("entity_id") REFERENCES "entities"("stable_id")
  ON DELETE CASCADE;

ALTER TABLE "facts"
  ADD CONSTRAINT "facts_subject_entities_stable_id_fk"
  FOREIGN KEY ("subject") REFERENCES "entities"("stable_id")
  ON DELETE SET NULL;

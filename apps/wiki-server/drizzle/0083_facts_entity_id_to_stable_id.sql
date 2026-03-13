-- Migrate facts.entity_id and facts.subject from entity slugs to stable IDs.
-- This is part of the unified ID migration (Discussion #2169).
--
-- Handles entities with NULL stable_id by deleting affected facts (Step 5).
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

-- Step 5: Delete facts whose entity_id couldn't be converted (entity exists
-- but has NULL stable_id). Without this, leftover slug values violate the FK.
DELETE FROM facts
WHERE entity_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);

-- Step 6: Null out subject values that couldn't be converted.
UPDATE facts SET subject = NULL
WHERE subject IS NOT NULL
  AND subject NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);

-- Step 7: Add new FK constraints referencing entities.stable_id.
ALTER TABLE "facts"
  ADD CONSTRAINT "facts_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("entity_id") REFERENCES "entities"("stable_id")
  ON DELETE CASCADE;

ALTER TABLE "facts"
  ADD CONSTRAINT "facts_subject_entities_stable_id_fk"
  FOREIGN KEY ("subject") REFERENCES "entities"("stable_id")
  ON DELETE SET NULL;

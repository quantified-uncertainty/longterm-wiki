-- Migration: Convert summaries.entity_id from slug-based to stableId-based FK
-- This is the Phase 0d migration for the Unified things Table plan (discussion #2169).
-- After this migration, summaries.entity_id references entities.stable_id instead of entities.id.

-- Step 1: Delete orphaned summaries (entity_id not in entities.id)
DELETE FROM summaries WHERE entity_id NOT IN (SELECT id FROM entities);

-- Step 2: Drop existing FK constraint
ALTER TABLE "summaries" DROP CONSTRAINT IF EXISTS "summaries_entity_id_entities_id_fk";

-- Step 3: Drop the primary key (needed to update entity_id values)
ALTER TABLE "summaries" DROP CONSTRAINT IF EXISTS "summaries_pkey";

-- Step 4: Convert entity_id from slug to stable_id
UPDATE summaries SET entity_id = e.stable_id
FROM entities e
WHERE summaries.entity_id = e.id AND e.stable_id IS NOT NULL;

-- Step 5: Delete any rows that could not be converted (entity has no stable_id)
DELETE FROM summaries WHERE entity_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);

-- Step 6: Re-add primary key
ALTER TABLE "summaries" ADD PRIMARY KEY ("entity_id");

-- Step 7: Add new FK constraint referencing entities.stable_id
ALTER TABLE "summaries" ADD CONSTRAINT "summaries_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("entity_id") REFERENCES "entities"("stable_id") ON DELETE CASCADE;

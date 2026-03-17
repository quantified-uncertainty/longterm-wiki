-- Entity Unification Phase 5: stableId becomes entities PK
--
-- Pre-conditions:
--   - All active FKs reference entities.stable_id (facts.entity_id, facts.subject, summaries.entity_id)
--   - entities.stable_id has a UNIQUE constraint and no NULLs
--   - Archived tables (_archived_claims, _archived_statements) still reference entities.id
--     but those FKs are preserved via the new UNIQUE constraint on id
--
-- This script is idempotent — safe to re-run.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/stableid-pk-migration.sql

BEGIN;

-- Step 1: Verify no NULL stable_ids exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entities WHERE stable_id IS NULL) THEN
    RAISE EXCEPTION 'Found entities with NULL stable_id — cannot proceed. Backfill stable_id first.';
  END IF;
  RAISE NOTICE 'Step 1: No NULL stable_ids found — OK';
END $$;

-- Step 2: Verify no NULL ids (slugs) exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entities WHERE id IS NULL) THEN
    RAISE EXCEPTION 'Found entities with NULL id — cannot proceed.';
  END IF;
  RAISE NOTICE 'Step 2: No NULL ids found — OK';
END $$;

-- Step 3: Drop FKs on archived tables that reference entities.id
-- These will be recreated after the PK swap to point at the new UNIQUE constraint on id.
DO $$
BEGIN
  -- _archived_claims.entity_id -> entities.id
  ALTER TABLE _archived_claims DROP CONSTRAINT IF EXISTS claims_entity_id_entities_id_fk;
  RAISE NOTICE 'Step 3a: Dropped claims FK (if existed)';
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Step 3a: _archived_claims table does not exist — skipping';
END $$;

DO $$
BEGIN
  -- _archived_statements.subject_entity_id -> entities.id
  ALTER TABLE _archived_statements DROP CONSTRAINT IF EXISTS statements_subject_entity_id_entities_id_fk;
  -- _archived_statements.value_entity_id -> entities.id
  ALTER TABLE _archived_statements DROP CONSTRAINT IF EXISTS statements_value_entity_id_entities_id_fk;
  -- _archived_statements.attributed_to -> entities.id
  ALTER TABLE _archived_statements DROP CONSTRAINT IF EXISTS statements_attributed_to_entities_id_fk;
  RAISE NOTICE 'Step 3b: Dropped statements FKs (if existed)';
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Step 3b: _archived_statements table does not exist — skipping';
END $$;

-- Step 4: Drop the old PK on entities.id
DO $$
BEGIN
  ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_pkey;
  RAISE NOTICE 'Step 4: Dropped old PK on entities.id (if existed)';
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'Step 4: Old PK already dropped';
END $$;

-- Step 5: Drop the existing unique constraint on stable_id (will be replaced by PK)
DO $$
BEGIN
  ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_stable_id_unique;
  RAISE NOTICE 'Step 5: Dropped unique constraint on stable_id (if existed)';
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'Step 5: Unique constraint already dropped';
END $$;

-- Step 6: Add PK on stable_id
DO $$
BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_pkey PRIMARY KEY (stable_id);
  RAISE NOTICE 'Step 6: Added PK on stable_id';
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'Step 6: PK on stable_id already exists';
END $$;

-- Step 7: Add unique constraint on id (slug) for URL resolution and archived table FKs
DO $$
BEGIN
  ALTER TABLE entities ADD CONSTRAINT entities_id_unique UNIQUE (id);
  RAISE NOTICE 'Step 7: Added unique constraint on id';
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'Step 7: Unique constraint on id already exists';
END $$;

-- Step 8: Set NOT NULL on both columns
ALTER TABLE entities ALTER COLUMN id SET NOT NULL;
ALTER TABLE entities ALTER COLUMN stable_id SET NOT NULL;

-- Step 9: Re-add FKs on archived tables pointing to entities.id (now unique, not PK)
DO $$
BEGIN
  ALTER TABLE _archived_claims
    ADD CONSTRAINT claims_entity_id_entities_id_fk
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE;
  RAISE NOTICE 'Step 9a: Re-added claims FK';
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Step 9a: _archived_claims does not exist — skipping';
  WHEN duplicate_object THEN
    RAISE NOTICE 'Step 9a: Claims FK already exists';
END $$;

DO $$
BEGIN
  ALTER TABLE _archived_statements
    ADD CONSTRAINT statements_subject_entity_id_entities_id_fk
    FOREIGN KEY (subject_entity_id) REFERENCES entities(id) ON DELETE CASCADE;
  ALTER TABLE _archived_statements
    ADD CONSTRAINT statements_value_entity_id_entities_id_fk
    FOREIGN KEY (value_entity_id) REFERENCES entities(id) ON DELETE SET NULL;
  ALTER TABLE _archived_statements
    ADD CONSTRAINT statements_attributed_to_entities_id_fk
    FOREIGN KEY (attributed_to) REFERENCES entities(id) ON DELETE SET NULL;
  RAISE NOTICE 'Step 9b: Re-added statements FKs';
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Step 9b: _archived_statements does not exist — skipping';
  WHEN duplicate_object THEN
    RAISE NOTICE 'Step 9b: Some statements FKs already exist';
END $$;

RAISE NOTICE 'Migration complete: stable_id is now the entities PK, id (slug) is UNIQUE + NOT NULL';

COMMIT;

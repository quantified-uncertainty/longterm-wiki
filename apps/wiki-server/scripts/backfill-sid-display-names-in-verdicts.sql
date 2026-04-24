-- backfill-sid-display-names-in-verdicts.sql (QUA-661)
--
-- Null out raw stableId (`sid_...`) values that leaked into
-- `source_check_verdicts.display_name` / `entity_display_name`.
--
-- Display-name columns must hold human-readable names or NULL — never a raw
-- `sid_`. When a sid_ lands here, the UI renders the opaque id verbatim and
-- QUA-650's retro-scan can't evaluate subject-identity because its fallback
-- claim label becomes the sid_ itself.
--
-- The PR that added this script (QUA-661) also introduced server-side
-- coercion in POST /api/sourcing/verdicts that rejects `sid_` values before
-- they land, so this is a one-shot cleanup for historical rows. Re-running
-- the script is a no-op once rows are cleaned.
--
-- Idempotent. Safe to run multiple times.
--
-- Usage:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-sid-display-names-in-verdicts.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- Diagnostic: show count of leaked rows before the fix
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  display_name_leaks integer;
  entity_display_name_leaks integer;
BEGIN
  SELECT COUNT(*) INTO display_name_leaks
  FROM source_check_verdicts
  WHERE display_name LIKE 'sid\_%' ESCAPE '\';

  SELECT COUNT(*) INTO entity_display_name_leaks
  FROM source_check_verdicts
  WHERE entity_display_name LIKE 'sid\_%' ESCAPE '\';

  RAISE NOTICE '=== Pre-fix State ===';
  RAISE NOTICE 'Rows with sid_ in display_name: %', display_name_leaks;
  RAISE NOTICE 'Rows with sid_ in entity_display_name: %', entity_display_name_leaks;
END $$;

-- ---------------------------------------------------------------------------
-- Clear leaked sid_ values from display_name
-- ---------------------------------------------------------------------------
-- LIKE 'sid\_%' ESCAPE '\' matches any value starting with the literal
-- characters `sid_` (the underscore is escaped so it's treated literally,
-- not as a single-char wildcard).

UPDATE source_check_verdicts
SET display_name = NULL,
    updated_at = now()
WHERE display_name LIKE 'sid\_%' ESCAPE '\';

-- ---------------------------------------------------------------------------
-- Clear leaked sid_ values from entity_display_name
-- ---------------------------------------------------------------------------

UPDATE source_check_verdicts
SET entity_display_name = NULL,
    updated_at = now()
WHERE entity_display_name LIKE 'sid\_%' ESCAPE '\';

-- ---------------------------------------------------------------------------
-- Verify zero leaked rows remain
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT COUNT(*) INTO remaining
  FROM source_check_verdicts
  WHERE display_name LIKE 'sid\_%' ESCAPE '\'
     OR entity_display_name LIKE 'sid\_%' ESCAPE '\';

  RAISE NOTICE '=== Post-fix State ===';
  RAISE NOTICE 'Remaining leaked rows: %', remaining;

  IF remaining > 0 THEN
    RAISE EXCEPTION 'Backfill failed: % rows still have sid_ values', remaining;
  END IF;
END $$;

COMMIT;

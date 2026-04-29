-- QUA-526 Phase 4a-2: CHECK constraint on entities.status.
--
-- Replaces the YAML-time check in crux/validate/validate-controlled-vocab.ts
-- for the entities.status column. Other fields covered by that validator
-- are either already PG-enforced (personnel.role_type and divisions.*
-- via migrations 0169 + 0173) or are YAML-only (orgType, severity, maturity,
-- projectStatus, policyStatus, orgStatus, clusters, relatedEntries.*) and
-- need a separate Zod-at-YAML-load enforcement path.
--
-- Allowed values mirror the EntityStatus Zod enum in data/schema.ts
-- ('stub', 'draft', 'published', 'verified'). NULL is permitted — current
-- prod state on 2026-04-28 is NULL=3,395 / stub=23 across 3,418 rows
-- (see PR description for the enumeration query output).
--
-- Uses the NOT VALID + VALIDATE CONSTRAINT pattern per
-- .claude/rules/database-migrations.md so the ACCESS EXCLUSIVE lock window
-- on the entities table stays minimal. Table is small (~3.4k rows) but
-- the table is wide (jsonb columns) and the same lock would also block any
-- /api/entities reader.

DO $$ BEGIN
  ALTER TABLE "entities"
    ADD CONSTRAINT chk_entities_status
    CHECK (status IS NULL OR status IN ('stub', 'draft', 'published', 'verified'))
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "entities" VALIDATE CONSTRAINT chk_entities_status;

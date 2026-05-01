-- QUA-426: add `not_applicable` to the allowed verdicts.
--
-- Pre-LLM relevance-gate short-circuits (see crux/lib/sourcing/relevance-gate.ts)
-- record a `not_applicable` verdict when the source content doesn't mention
-- the record's subject at all. The value must be permitted in both
-- source_check_evidence (evidence rows) and source_check_verdicts (aggregate).
--
-- `source_check_evidence` is the heavy-write table in this subsystem.
-- Dropping and re-adding a CHECK constraint as VALID would scan every row
-- while holding ACCESS EXCLUSIVE — any concurrent writer would time out
-- against the 60s lock_timeout configured in apps/wiki-server/src/db.ts.
-- Use the NOT VALID + VALIDATE CONSTRAINT pattern from
-- docs/agent-rules/database-migrations.md so Phase 1 is a metadata-only
-- operation (milliseconds) and Phase 2 scans without ACCESS EXCLUSIVE.
--
-- source_check_verdicts is smaller (~12K rows today) so the same pattern
-- costs nothing extra there but keeps the two table migrations symmetric.

-- ── source_check_evidence ─────────────────────────────────────────────

-- Phase 0: drop the old constraint. Idempotent so a partial re-run works.
DO $$ BEGIN
  ALTER TABLE "source_check_evidence"
    DROP CONSTRAINT chk_source_check_evidence_verdict;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Phase 1: register the new constraint as NOT VALID (ACCESS EXCLUSIVE for
-- milliseconds; no row scan, safe under concurrent writes).
DO $$ BEGIN
  ALTER TABLE "source_check_evidence"
    ADD CONSTRAINT chk_source_check_evidence_verdict
    CHECK (verdict IS NULL OR verdict IN (
      'confirmed',
      'contradicted',
      'unverifiable',
      'outdated',
      'partial',
      'not_applicable'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Phase 2: validate against existing rows (SHARE UPDATE EXCLUSIVE — concurrent
-- SELECT/INSERT/UPDATE are allowed). Safe because the new value set is a
-- strict superset of the old one, so all existing rows already satisfy it.
ALTER TABLE "source_check_evidence"
  VALIDATE CONSTRAINT chk_source_check_evidence_verdict;

-- ── source_check_verdicts ─────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "source_check_verdicts"
    DROP CONSTRAINT chk_source_check_verdicts_verdict;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "source_check_verdicts"
    ADD CONSTRAINT chk_source_check_verdicts_verdict
    CHECK (verdict IN (
      'confirmed',
      'contradicted',
      'unverifiable',
      'outdated',
      'partial',
      'unchecked',
      'not_applicable'
    )) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "source_check_verdicts"
  VALIDATE CONSTRAINT chk_source_check_verdicts_verdict;

-- Epic #4017 Phase B2: Add CHECK constraints on 13 status/enum columns.
--
-- These columns already have Zod validation at the API layer. This migration
-- adds the matching DB-level constraints so bad data can't enter even via
-- direct SQL, migrations, or bypassed code paths.
--
-- Each ADD CONSTRAINT is wrapped in a DO block with EXCEPTION handling so the
-- migration is idempotent — safe to re-run if interrupted partway through.
--
-- Note: incidents.status was in the original plan but the incidents table does
-- not exist in the schema (it was never created or was removed). The constraint
-- is intentionally omitted.

-- 1. jobs.status
DO $$ BEGIN
  ALTER TABLE "jobs"
    ADD CONSTRAINT chk_jobs_status
    CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. auto_update_results.status
DO $$ BEGIN
  ALTER TABLE "auto_update_results"
    ADD CONSTRAINT chk_auto_update_results_status
    CHECK (status IN ('success', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. source_check_verdicts.verdict
-- 'unchecked' is a valid verdict used by POST /verdicts (VALID_VERDICT_TYPES
-- in source-checks.ts includes it). Omitting it would cause a BLOCKER on
-- deploy because existing rows with 'unchecked' verdicts exist in production.
DO $$ BEGIN
  ALTER TABLE "source_check_verdicts"
    ADD CONSTRAINT chk_source_check_verdicts_verdict
    CHECK (verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial', 'unchecked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. grants.status (nullable — NULL is allowed, but non-null values must be valid)
DO $$ BEGIN
  ALTER TABLE "grants"
    ADD CONSTRAINT chk_grants_status
    CHECK (status IS NULL OR status IN ('active', 'completed', 'winding-down'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. divisions.status (nullable)
DO $$ BEGIN
  ALTER TABLE "divisions"
    ADD CONSTRAINT chk_divisions_status
    CHECK (status IS NULL OR status IN ('active', 'inactive', 'dissolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. funding_programs.status (nullable)
DO $$ BEGIN
  ALTER TABLE "funding_programs"
    ADD CONSTRAINT chk_funding_programs_status
    CHECK (status IS NULL OR status IN ('open', 'closed', 'awarded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. resources.enrichment_status (nullable)
DO $$ BEGIN
  ALTER TABLE "resources"
    ADD CONSTRAINT chk_resources_enrichment_status
    CHECK (enrichment_status IS NULL OR enrichment_status IN ('pending', 'fetched', 'classified', 'enriched', 'reviewed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 8. resources.fetch_status (nullable)
DO $$ BEGIN
  ALTER TABLE "resources"
    ADD CONSTRAINT chk_resources_fetch_status
    CHECK (fetch_status IS NULL OR fetch_status IN ('ok', 'dead', 'soft_404', 'not_found', 'timeout', 'unreachable', 'paywall', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 9. political_races.status
DO $$ BEGIN
  ALTER TABLE "political_races"
    ADD CONSTRAINT chk_political_races_status
    CHECK (status IN ('upcoming', 'active', 'resolved', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 10. race_candidates.status
DO $$ BEGIN
  ALTER TABLE "race_candidates"
    ADD CONSTRAINT chk_race_candidates_status
    CHECK (status IN ('running', 'won', 'lost', 'withdrew'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 11. agent_sessions.status
DO $$ BEGIN
  ALTER TABLE "agent_sessions"
    ADD CONSTRAINT chk_agent_sessions_status
    CHECK (status IN ('active', 'completed', 'errored', 'stale'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 12. research_areas.status
DO $$ BEGIN
  ALTER TABLE "research_areas"
    ADD CONSTRAINT chk_research_areas_status
    CHECK (status IN ('active', 'emerging', 'mature', 'declining', 'archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 13. source_check_evidence.verdict (same enum as verdicts table)
DO $$ BEGIN
  ALTER TABLE "source_check_evidence"
    ADD CONSTRAINT chk_source_check_evidence_verdict
    CHECK (verdict IS NULL OR verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

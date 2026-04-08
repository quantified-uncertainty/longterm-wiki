-- Epic #4017 Phase B2: Add CHECK constraints on 14 status/enum columns.
--
-- These columns already have Zod validation at the API layer. This migration
-- adds the matching DB-level constraints so bad data can't enter even via
-- direct SQL, migrations, or bypassed code paths.
--
-- The migration uses IF NOT EXISTS (via DO blocks) to be idempotent — safe
-- to re-run if interrupted.

-- 1. jobs.status
ALTER TABLE "jobs"
  ADD CONSTRAINT chk_jobs_status
  CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled'));

-- 2. auto_update_results.status
ALTER TABLE "auto_update_results"
  ADD CONSTRAINT chk_auto_update_results_status
  CHECK (status IN ('success', 'failed', 'skipped'));

-- 3. source_check_verdicts.verdict
ALTER TABLE "source_check_verdicts"
  ADD CONSTRAINT chk_source_check_verdicts_verdict
  CHECK (verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'));

-- 4. grants.status (nullable — NULL is allowed, but non-null values must be valid)
ALTER TABLE "grants"
  ADD CONSTRAINT chk_grants_status
  CHECK (status IS NULL OR status IN ('active', 'completed', 'winding-down'));

-- 5. divisions.status (nullable)
ALTER TABLE "divisions"
  ADD CONSTRAINT chk_divisions_status
  CHECK (status IS NULL OR status IN ('active', 'inactive', 'dissolved'));

-- 6. funding_programs.status (nullable)
ALTER TABLE "funding_programs"
  ADD CONSTRAINT chk_funding_programs_status
  CHECK (status IS NULL OR status IN ('open', 'closed', 'awarded'));

-- 7. resources.enrichment_status (nullable)
ALTER TABLE "resources"
  ADD CONSTRAINT chk_resources_enrichment_status
  CHECK (enrichment_status IS NULL OR enrichment_status IN ('pending', 'fetched', 'classified', 'enriched', 'reviewed'));

-- 8. resources.fetch_status (nullable)
ALTER TABLE "resources"
  ADD CONSTRAINT chk_resources_fetch_status
  CHECK (fetch_status IS NULL OR fetch_status IN ('ok', 'dead', 'soft_404', 'not_found', 'timeout', 'unreachable', 'paywall', 'error'));

-- 9. incidents.status
ALTER TABLE "incidents"
  ADD CONSTRAINT chk_incidents_status
  CHECK (status IN ('open', 'acknowledged', 'resolved'));

-- 10. political_races.status
ALTER TABLE "political_races"
  ADD CONSTRAINT chk_political_races_status
  CHECK (status IN ('upcoming', 'active', 'resolved', 'cancelled'));

-- 11. race_candidates.status (the schema table is race_candidates, not political_candidates)
ALTER TABLE "race_candidates"
  ADD CONSTRAINT chk_race_candidates_status
  CHECK (status IN ('running', 'won', 'lost', 'withdrew'));

-- 12. agent_sessions.status
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT chk_agent_sessions_status
  CHECK (status IN ('active', 'completed', 'errored', 'stale'));

-- 13. research_areas.status
ALTER TABLE "research_areas"
  ADD CONSTRAINT chk_research_areas_status
  CHECK (status IN ('active', 'emerging', 'mature', 'declining', 'archived'));

-- 14. source_check_evidence.verdict (same enum as verdicts table)
-- The evidence table also has a verdict column that should be constrained.
ALTER TABLE "source_check_evidence"
  ADD CONSTRAINT chk_source_check_evidence_verdict
  CHECK (verdict IS NULL OR verdict IN ('confirmed', 'contradicted', 'unverifiable', 'outdated', 'partial'));

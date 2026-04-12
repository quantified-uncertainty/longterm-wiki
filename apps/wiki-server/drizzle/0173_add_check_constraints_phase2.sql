-- QUA-156: Add CHECK constraints on enum-like text columns — Phase 2.
--
-- Phase 1 (migration 0169) covered 13 columns: jobs.status,
-- auto_update_results.status, source_check_verdicts.verdict, grants.status,
-- divisions.status, funding_programs.status, resources.enrichment_status,
-- resources.fetch_status, political_races.status, race_candidates.status,
-- agent_sessions.status, research_areas.status, source_check_evidence.verdict.
--
-- This migration adds constraints for the remaining enum-like columns that
-- have Zod validation at the API layer but no matching DB-level guard.
--
-- Each ADD CONSTRAINT is wrapped in a DO block with EXCEPTION handling so the
-- migration is idempotent — safe to re-run if interrupted partway through.

-- 1. hallucination_risk_snapshots.level
DO $$ BEGIN
  ALTER TABLE "hallucination_risk_snapshots"
    ADD CONSTRAINT chk_hrs_level
    CHECK (level IN ('low', 'medium', 'high'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. page_links.link_type
DO $$ BEGIN
  ALTER TABLE "page_links"
    ADD CONSTRAINT chk_page_links_link_type
    CHECK (link_type IN ('yaml_related', 'entity_link', 'name_prefix', 'similarity', 'shared_tag'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. personnel.role_type
DO $$ BEGIN
  ALTER TABLE "personnel"
    ADD CONSTRAINT chk_personnel_role_type
    CHECK (role_type IN ('key-person', 'board', 'career'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. divisions.division_type
DO $$ BEGIN
  ALTER TABLE "divisions"
    ADD CONSTRAINT chk_divisions_division_type
    CHECK (division_type IN ('fund', 'team', 'department', 'lab', 'program-area'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. funding_programs.program_type
DO $$ BEGIN
  ALTER TABLE "funding_programs"
    ADD CONSTRAINT chk_funding_programs_program_type
    CHECK (program_type IN ('rfp', 'grant-round', 'fellowship', 'prize', 'solicitation', 'call'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 6. entity_events.event_type
DO $$ BEGIN
  ALTER TABLE "entity_events"
    ADD CONSTRAINT chk_entity_events_event_type
    CHECK (event_type IN ('founding', 'acquisition', 'pivot', 'launch', 'publication', 'policy', 'milestone', 'leadership-change', 'incident', 'funding', 'dissolution', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 7. entity_events.significance (nullable)
DO $$ BEGIN
  ALTER TABLE "entity_events"
    ADD CONSTRAINT chk_entity_events_significance
    CHECK (significance IS NULL OR significance IN ('major', 'moderate', 'minor'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 8. entity_assessments.assessor
DO $$ BEGIN
  ALTER TABLE "entity_assessments"
    ADD CONSTRAINT chk_entity_assessments_assessor
    CHECK (assessor IN ('editorial', 'llm', 'community', 'external'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 9. publications.publication_type
DO $$ BEGIN
  ALTER TABLE "publications"
    ADD CONSTRAINT chk_publications_publication_type
    CHECK (publication_type IN ('paper', 'report', 'blog-post', 'book', 'thesis', 'preprint', 'policy-brief'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 10. research_area_organizations.role
DO $$ BEGIN
  ALTER TABLE "research_area_organizations"
    ADD CONSTRAINT chk_rao_role
    CHECK (role IN ('pioneer', 'active', 'major', 'funder', 'emerging'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 11. research_area_risks.relevance
DO $$ BEGIN
  ALTER TABLE "research_area_risks"
    ADD CONSTRAINT chk_rar_relevance
    CHECK (relevance IN ('addresses', 'studies', 'exacerbates'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 12. research_area_risks.effectiveness (nullable)
DO $$ BEGIN
  ALTER TABLE "research_area_risks"
    ADD CONSTRAINT chk_rar_effectiveness
    CHECK (effectiveness IS NULL OR effectiveness IN ('high', 'moderate', 'low', 'uncertain'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 13. research_area_evaluations.evaluator_type
DO $$ BEGIN
  ALTER TABLE "research_area_evaluations"
    ADD CONSTRAINT chk_rae_evaluator_type
    CHECK (evaluator_type IN ('llm', 'human'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 14. evaluation_dimensions.category (nullable)
DO $$ BEGIN
  ALTER TABLE "evaluation_dimensions"
    ADD CONSTRAINT chk_eval_dimensions_category
    CHECK (category IS NULL OR category IN ('prioritization', 'field-health', 'impact'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 15. page_improve_runs.engine
DO $$ BEGIN
  ALTER TABLE "page_improve_runs"
    ADD CONSTRAINT chk_pir_engine
    CHECK (engine IN ('v1', 'v2'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 16. page_improve_runs.tier
DO $$ BEGIN
  ALTER TABLE "page_improve_runs"
    ADD CONSTRAINT chk_pir_tier
    CHECK (tier IN ('polish', 'standard', 'deep'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 17. groundskeeper_runs.event
DO $$ BEGIN
  ALTER TABLE "groundskeeper_runs"
    ADD CONSTRAINT chk_gkr_event
    CHECK (event IN ('success', 'failure', 'error', 'circuit_breaker_tripped', 'circuit_breaker_reset', 'half_open_attempt', 'half_open_success', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 18. service_health_incidents.severity
DO $$ BEGIN
  ALTER TABLE "service_health_incidents"
    ADD CONSTRAINT chk_shi_severity
    CHECK (severity IN ('P0', 'P1', 'P2'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 19. service_health_incidents.status
DO $$ BEGIN
  ALTER TABLE "service_health_incidents"
    ADD CONSTRAINT chk_shi_status
    CHECK (status IN ('open', 'acknowledged', 'resolved'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 20. agent_session_events.event_type
DO $$ BEGIN
  ALTER TABLE "agent_session_events"
    ADD CONSTRAINT chk_ase_event_type
    CHECK (event_type IN ('registered', 'checklist_check', 'status_update', 'error', 'note', 'completed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 21. political_offices.status
DO $$ BEGIN
  ALTER TABLE "political_offices"
    ADD CONSTRAINT chk_political_offices_status
    CHECK (status IN ('incumbent', 'candidate', 'former'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 22. political_offices.office_type
DO $$ BEGIN
  ALTER TABLE "political_offices"
    ADD CONSTRAINT chk_political_offices_office_type
    CHECK (office_type IN ('senator', 'representative', 'governor', 'state_senator', 'state_representative', 'attorney_general', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 23. proposed_claims.status
DO $$ BEGIN
  ALTER TABLE "proposed_claims"
    ADD CONSTRAINT chk_proposed_claims_status
    CHECK (status IN ('pending', 'verifying', 'verified', 'contradicted', 'unverifiable', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 24. resource_tabular_sources.data_format
DO $$ BEGIN
  ALTER TABLE "resource_tabular_sources"
    ADD CONSTRAINT chk_rts_data_format
    CHECK (data_format IN ('csv', 'html_table', 'json_api', 'spreadsheet'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 25. resource_tabular_sources.access_method
DO $$ BEGIN
  ALTER TABLE "resource_tabular_sources"
    ADD CONSTRAINT chk_rts_access_method
    CHECK (access_method IN ('direct_download', 'api_endpoint', 'web_scrape', 'manual_export'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 26. resource_tabular_sources.source_status
DO $$ BEGIN
  ALTER TABLE "resource_tabular_sources"
    ADD CONSTRAINT chk_rts_source_status
    CHECK (source_status IN ('active', 'archived', 'defunct'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 27. page_snapshots.extraction_status
DO $$ BEGIN
  ALTER TABLE "page_snapshots"
    ADD CONSTRAINT chk_ps_extraction_status
    CHECK (extraction_status IN ('pending', 'extracted', 'failed', 'skipped'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 28. secondary_market_prices.price_type
DO $$ BEGIN
  ALTER TABLE "secondary_market_prices"
    ADD CONSTRAINT chk_smp_price_type
    CHECK (price_type IN ('mark', 'oracle', 'last_trade', 'indicative', 'bid', 'ask', 'mid'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 29. political_votes.vote
DO $$ BEGIN
  ALTER TABLE "political_votes"
    ADD CONSTRAINT chk_political_votes_vote
    CHECK (vote IN ('yea', 'nay', 'abstain', 'not_voting', 'present'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 30. wikibase_page_assessments.assessor
DO $$ BEGIN
  ALTER TABLE "wikibase_page_assessments"
    ADD CONSTRAINT chk_wpa_assessor
    CHECK (assessor IN ('structural', 'llm-grading', 'editorial', 'frontmatter-sync'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 31. political_races.race_type
DO $$ BEGIN
  ALTER TABLE "political_races"
    ADD CONSTRAINT chk_political_races_race_type
    CHECK (race_type IN ('primary', 'general', 'runoff', 'special', 'ballot_measure'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 32. political_races.level
DO $$ BEGIN
  ALTER TABLE "political_races"
    ADD CONSTRAINT chk_political_races_level
    CHECK (level IN ('federal_house', 'federal_senate', 'state_governor', 'state_legislature', 'ballot_measure'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 33. policy_stakeholders.position
DO $$ BEGIN
  ALTER TABLE "policy_stakeholders"
    ADD CONSTRAINT chk_policy_stakeholders_position
    CHECK (position IN ('support', 'oppose', 'neutral', 'mixed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 34. policy_stakeholders.importance (nullable)
DO $$ BEGIN
  ALTER TABLE "policy_stakeholders"
    ADD CONSTRAINT chk_policy_stakeholders_importance
    CHECK (importance IS NULL OR importance IN ('high', 'medium', 'low'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 35. prediction_market_questions.question_type
DO $$ BEGIN
  ALTER TABLE "prediction_market_questions"
    ADD CONSTRAINT chk_pmq_question_type
    CHECK (question_type IN ('binary', 'numeric', 'multiple_choice'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 36. race_candidates.ai_stance (nullable)
DO $$ BEGIN
  ALTER TABLE "race_candidates"
    ADD CONSTRAINT chk_race_candidates_ai_stance
    CHECK (ai_stance IS NULL OR ai_stance IN ('pro_regulation', 'anti_regulation', 'mixed', 'neutral'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 37. race_candidates.pac_position (nullable)
DO $$ BEGIN
  ALTER TABLE "race_candidates"
    ADD CONSTRAINT chk_race_candidates_pac_position
    CHECK (pac_position IS NULL OR pac_position IN ('support', 'oppose'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Migration: Add sid_ prefix to all entity stableIds
--
-- This migration prefixes all entity stableIds with "sid_" to make them
-- trivially distinguishable from slugs and names (detection = startsWith("sid_")).
--
-- Replaces 7+ regex-based heuristic ID detection functions with one startsWith check.
--
-- Idempotent: all UPDATEs use WHERE ... NOT LIKE 'sid_%' to skip already-prefixed values.

-- ══════════════════════════════════════════════════════════════════════
-- Step 1: Update all CHILD FK columns FIRST (before parent entities.stable_id)
-- This avoids FK constraint violations since children must match parent values.
-- ══════════════════════════════════════════════════════════════════════

-- facts.entity_id (FK to entities.stable_id)
UPDATE facts SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%';

-- fact_timeseries.entity_id
UPDATE fact_timeseries SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%';

-- fact_timeseries.subject
UPDATE fact_timeseries SET subject = 'sid_' || subject
WHERE subject IS NOT NULL AND subject NOT LIKE 'sid_%'
  AND length(subject) = 10 AND subject ~ '^[A-Za-z0-9]{10}$';

-- personnel.person_entity_id
UPDATE personnel SET person_entity_id = 'sid_' || person_entity_id
WHERE person_entity_id IS NOT NULL AND person_entity_id NOT LIKE 'sid_%';

-- personnel.org_entity_id
UPDATE personnel SET org_entity_id = 'sid_' || org_entity_id
WHERE org_entity_id IS NOT NULL AND org_entity_id NOT LIKE 'sid_%';

-- grants.org_entity_id
UPDATE grants SET org_entity_id = 'sid_' || org_entity_id
WHERE org_entity_id IS NOT NULL AND org_entity_id NOT LIKE 'sid_%';

-- grants.grantee_entity_id
UPDATE grants SET grantee_entity_id = 'sid_' || grantee_entity_id
WHERE grantee_entity_id IS NOT NULL AND grantee_entity_id NOT LIKE 'sid_%';

-- funding_rounds.company_entity_id
UPDATE funding_rounds SET company_entity_id = 'sid_' || company_entity_id
WHERE company_entity_id IS NOT NULL AND company_entity_id NOT LIKE 'sid_%';

-- funding_rounds.lead_investor_entity_id
UPDATE funding_rounds SET lead_investor_entity_id = 'sid_' || lead_investor_entity_id
WHERE lead_investor_entity_id IS NOT NULL AND lead_investor_entity_id NOT LIKE 'sid_%';

-- investments.company_entity_id
UPDATE investments SET company_entity_id = 'sid_' || company_entity_id
WHERE company_entity_id IS NOT NULL AND company_entity_id NOT LIKE 'sid_%';

-- investments.investor_entity_id
UPDATE investments SET investor_entity_id = 'sid_' || investor_entity_id
WHERE investor_entity_id IS NOT NULL AND investor_entity_id NOT LIKE 'sid_%';

-- equity_positions.company_entity_id
UPDATE equity_positions SET company_entity_id = 'sid_' || company_entity_id
WHERE company_entity_id IS NOT NULL AND company_entity_id NOT LIKE 'sid_%';

-- equity_positions.holder_entity_id
UPDATE equity_positions SET holder_entity_id = 'sid_' || holder_entity_id
WHERE holder_entity_id IS NOT NULL AND holder_entity_id NOT LIKE 'sid_%';

-- secondary_market_prices.company_entity_id
UPDATE secondary_market_prices SET company_entity_id = 'sid_' || company_entity_id
WHERE company_entity_id IS NOT NULL AND company_entity_id NOT LIKE 'sid_%';

-- divisions.parent_org_id
UPDATE divisions SET parent_org_id = 'sid_' || parent_org_id
WHERE parent_org_id IS NOT NULL AND parent_org_id NOT LIKE 'sid_%'
  AND length(parent_org_id) = 10 AND parent_org_id ~ '^[A-Za-z0-9]{10}$';

-- division_personnel.person_id (FK to entities.stable_id)
UPDATE division_personnel SET person_id = 'sid_' || person_id
WHERE person_id IS NOT NULL AND person_id NOT LIKE 'sid_%'
  AND length(person_id) = 10 AND person_id ~ '^[A-Za-z0-9]{10}$';

-- benchmark_results.model_id (FK to entities.stable_id)
UPDATE benchmark_results SET model_id = 'sid_' || model_id
WHERE model_id IS NOT NULL AND model_id NOT LIKE 'sid_%'
  AND length(model_id) = 10 AND model_id ~ '^[A-Za-z0-9]{10}$';

-- entity_events.entity_id
UPDATE entity_events SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%';

-- entity_assessments.entity_id
UPDATE entity_assessments SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%';

-- publications.entity_id
UPDATE publications SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%';

-- website_sources.entity_id
UPDATE website_sources SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%'
  AND length(entity_id) = 10 AND entity_id ~ '^[A-Za-z0-9]{10}$';

-- policy_stakeholders.policy_entity_id
UPDATE policy_stakeholders SET policy_entity_id = 'sid_' || policy_entity_id
WHERE policy_entity_id IS NOT NULL AND policy_entity_id NOT LIKE 'sid_%';

-- policy_stakeholders.stakeholder_entity_id
UPDATE policy_stakeholders SET stakeholder_entity_id = 'sid_' || stakeholder_entity_id
WHERE stakeholder_entity_id IS NOT NULL AND stakeholder_entity_id NOT LIKE 'sid_%';

-- prediction_market_questions.entity_id
UPDATE prediction_market_questions SET entity_id = 'sid_' || entity_id
WHERE entity_id IS NOT NULL AND entity_id NOT LIKE 'sid_%'
  AND length(entity_id) = 10 AND entity_id ~ '^[A-Za-z0-9]{10}$';

-- bluesky_accounts.entity_stable_id
UPDATE bluesky_accounts SET entity_stable_id = 'sid_' || entity_stable_id
WHERE entity_stable_id IS NOT NULL AND entity_stable_id NOT LIKE 'sid_%';

-- agent_session_entities.entity_stable_id
UPDATE agent_session_entities SET entity_stable_id = 'sid_' || entity_stable_id
WHERE entity_stable_id IS NOT NULL AND entity_stable_id NOT LIKE 'sid_%';

-- ══════════════════════════════════════════════════════════════════════
-- Step 2: NOW update the parent entities.stable_id
-- All children already have sid_ prefix, so FK constraints are satisfied.
-- ══════════════════════════════════════════════════════════════════════

UPDATE entities SET stable_id = 'sid_' || stable_id
WHERE stable_id IS NOT NULL
  AND stable_id NOT LIKE 'sid_%';

-- ══════════════════════════════════════════════════════════════════════
-- Step 4: Update raw ID columns that may contain stableIds
-- (personId, organizationId, granteeId, etc.)
-- Only update values that look like bare stableIds (10-char alphanumeric)
-- ══════════════════════════════════════════════════════════════════════

-- personnel.person_id — only where it's a bare stableId (not a slug or display name)
UPDATE personnel SET person_id = 'sid_' || person_id
WHERE person_id NOT LIKE 'sid_%'
  AND person_id NOT LIKE 'new:%'
  AND length(person_id) = 10
  AND person_id ~ '^[A-Za-z0-9]{10}$';

-- personnel.organization_id
UPDATE personnel SET organization_id = 'sid_' || organization_id
WHERE organization_id NOT LIKE 'sid_%'
  AND length(organization_id) = 10
  AND organization_id ~ '^[A-Za-z0-9]{10}$';

-- grants.organization_id
UPDATE grants SET organization_id = 'sid_' || organization_id
WHERE organization_id NOT LIKE 'sid_%'
  AND length(organization_id) = 10
  AND organization_id ~ '^[A-Za-z0-9]{10}$';

-- grants.grantee_id
UPDATE grants SET grantee_id = 'sid_' || grantee_id
WHERE grantee_id NOT LIKE 'sid_%'
  AND grantee_id !~ '^\d+$'
  AND length(grantee_id) = 10
  AND grantee_id ~ '^[A-Za-z0-9]{10}$';

-- funding_rounds.company_id
UPDATE funding_rounds SET company_id = 'sid_' || company_id
WHERE company_id NOT LIKE 'sid_%'
  AND length(company_id) = 10
  AND company_id ~ '^[A-Za-z0-9]{10}$';

-- funding_rounds.lead_investor (text field, may contain display name)
UPDATE funding_rounds SET lead_investor = 'sid_' || lead_investor
WHERE lead_investor IS NOT NULL
  AND lead_investor NOT LIKE 'sid_%'
  AND length(lead_investor) = 10
  AND lead_investor ~ '^[A-Za-z0-9]{10}$';

-- investments.company_id
UPDATE investments SET company_id = 'sid_' || company_id
WHERE company_id NOT LIKE 'sid_%'
  AND length(company_id) = 10
  AND company_id ~ '^[A-Za-z0-9]{10}$';

-- investments.investor_id
UPDATE investments SET investor_id = 'sid_' || investor_id
WHERE investor_id NOT LIKE 'sid_%'
  AND length(investor_id) = 10
  AND investor_id ~ '^[A-Za-z0-9]{10}$';

-- equity_positions.company_id
UPDATE equity_positions SET company_id = 'sid_' || company_id
WHERE company_id NOT LIKE 'sid_%'
  AND length(company_id) = 10
  AND company_id ~ '^[A-Za-z0-9]{10}$';

-- equity_positions.holder_id
UPDATE equity_positions SET holder_id = 'sid_' || holder_id
WHERE holder_id NOT LIKE 'sid_%'
  AND length(holder_id) = 10
  AND holder_id ~ '^[A-Za-z0-9]{10}$';

-- funding_programs.org_id
UPDATE funding_programs SET org_id = 'sid_' || org_id
WHERE org_id NOT LIKE 'sid_%'
  AND length(org_id) = 10
  AND org_id ~ '^[A-Za-z0-9]{10}$';

-- ══════════════════════════════════════════════════════════════════════
-- Step 5: Clean up display name columns that contain bare stableIds
-- ══════════════════════════════════════════════════════════════════════

UPDATE personnel SET person_display_name = NULL
WHERE person_display_name IS NOT NULL
  AND length(person_display_name) = 10
  AND person_display_name ~ '^[A-Za-z0-9]{10}$';

UPDATE personnel SET org_display_name = NULL
WHERE org_display_name IS NOT NULL
  AND length(org_display_name) = 10
  AND org_display_name ~ '^[A-Za-z0-9]{10}$';

UPDATE grants SET grantee_display_name = NULL
WHERE grantee_display_name IS NOT NULL
  AND length(grantee_display_name) = 10
  AND grantee_display_name ~ '^[A-Za-z0-9]{10}$';

UPDATE grants SET org_display_name = NULL
WHERE org_display_name IS NOT NULL
  AND length(org_display_name) = 10
  AND org_display_name ~ '^[A-Za-z0-9]{10}$';

-- ══════════════════════════════════════════════════════════════════════
-- Step 6: Re-resolve entity FKs now that IDs are prefixed
-- (Some records had stableIds in raw columns but no FK set)
-- ══════════════════════════════════════════════════════════════════════

-- Personnel: resolve person_entity_id from person_id
UPDATE personnel p SET person_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = p.person_id OR e.id = p.person_id)
  AND p.person_entity_id IS NULL
  AND p.person_id NOT LIKE 'new:%';

-- Personnel: resolve org_entity_id from organization_id
UPDATE personnel p SET org_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = p.organization_id OR e.id = p.organization_id)
  AND p.org_entity_id IS NULL;

-- Grants: resolve org_entity_id
UPDATE grants g SET org_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = g.organization_id OR e.id = g.organization_id)
  AND g.org_entity_id IS NULL;

-- Grants: resolve grantee_entity_id
UPDATE grants g SET grantee_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = g.grantee_id OR e.id = g.grantee_id)
  AND g.grantee_entity_id IS NULL
  AND g.grantee_id !~ '^\d+$';

-- Investments: resolve company_entity_id
UPDATE investments i SET company_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = i.company_id OR e.id = i.company_id)
  AND i.company_entity_id IS NULL;

-- Investments: resolve investor_entity_id
UPDATE investments i SET investor_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = i.investor_id OR e.id = i.investor_id)
  AND i.investor_entity_id IS NULL;

-- Equity positions: resolve company_entity_id
UPDATE equity_positions ep SET company_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = ep.company_id OR e.id = ep.company_id)
  AND ep.company_entity_id IS NULL;

-- Equity positions: resolve holder_entity_id
UPDATE equity_positions ep SET holder_entity_id = e.stable_id
FROM entities e
WHERE (e.stable_id = ep.holder_id OR e.id = ep.holder_id)
  AND ep.holder_entity_id IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- Step 7: Add CHECK constraints to prevent stableIds in display name columns
-- Idempotent: uses DO block with EXCEPTION handler to skip existing constraints.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  ALTER TABLE personnel ADD CONSTRAINT chk_person_display_name_not_sid
    CHECK (person_display_name IS NULL OR person_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE personnel ADD CONSTRAINT chk_org_display_name_not_sid
    CHECK (org_display_name IS NULL OR org_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE grants ADD CONSTRAINT chk_grantee_display_name_not_sid
    CHECK (grantee_display_name IS NULL OR grantee_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE grants ADD CONSTRAINT chk_grant_org_display_name_not_sid
    CHECK (org_display_name IS NULL OR org_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE funding_rounds ADD CONSTRAINT chk_fr_company_display_name_not_sid
    CHECK (company_display_name IS NULL OR company_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE funding_rounds ADD CONSTRAINT chk_fr_lead_investor_display_name_not_sid
    CHECK (lead_investor_display_name IS NULL OR lead_investor_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE investments ADD CONSTRAINT chk_inv_company_display_name_not_sid
    CHECK (company_display_name IS NULL OR company_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE investments ADD CONSTRAINT chk_inv_investor_display_name_not_sid
    CHECK (investor_display_name IS NULL OR investor_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE equity_positions ADD CONSTRAINT chk_eq_company_display_name_not_sid
    CHECK (company_display_name IS NULL OR company_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE equity_positions ADD CONSTRAINT chk_eq_holder_display_name_not_sid
    CHECK (holder_display_name IS NULL OR holder_display_name NOT LIKE 'sid_%');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

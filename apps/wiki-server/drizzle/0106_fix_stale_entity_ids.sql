-- Fix stale FactBase entity IDs in PG tables.
--
-- Two entities were assigned new stableIds during Entity Unification but
-- existing PG rows still reference the old FactBase IDs:
--
--   Survival and Flourishing Fund: sIFjGbxVct -> pvJ50HupEQ
--   Center for AI Safety:          oa9A0OV0RX -> y4bieqSeag
--
-- This migration updates all legacy ID columns AND resolved FK columns
-- across all affected tables. All tables are small (<5000 rows each),
-- so this runs in milliseconds.
--
-- Idempotent: WHERE clauses ensure rows already using canonical IDs
-- are not touched. Safe to run multiple times.

-- ============================================================
-- Define the mapping (old FactBase ID -> canonical TableBase stableId)
-- ============================================================

-- We use repeated UPDATE statements, each targeting one (table, column).

-- ============================================================
-- GRANTS
-- ============================================================

-- Legacy column: organization_id (grantor)
UPDATE grants
SET organization_id = 'pvJ50HupEQ', updated_at = now()
WHERE organization_id = 'sIFjGbxVct';

UPDATE grants
SET organization_id = 'y4bieqSeag', updated_at = now()
WHERE organization_id = 'oa9A0OV0RX';

-- Legacy column: grantee_id (recipient)
UPDATE grants
SET grantee_id = 'pvJ50HupEQ', updated_at = now()
WHERE grantee_id = 'sIFjGbxVct';

UPDATE grants
SET grantee_id = 'y4bieqSeag', updated_at = now()
WHERE grantee_id = 'oa9A0OV0RX';

-- Resolved FK: org_entity_id
UPDATE grants
SET org_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE org_entity_id = 'sIFjGbxVct';

UPDATE grants
SET org_entity_id = 'y4bieqSeag', updated_at = now()
WHERE org_entity_id = 'oa9A0OV0RX';

-- Resolved FK: grantee_entity_id
UPDATE grants
SET grantee_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE grantee_entity_id = 'sIFjGbxVct';

UPDATE grants
SET grantee_entity_id = 'y4bieqSeag', updated_at = now()
WHERE grantee_entity_id = 'oa9A0OV0RX';

-- Backfill org_entity_id for SFF grants that were missed by 0103
-- (0103 could not resolve sIFjGbxVct because it's neither a slug nor a current stableId)
UPDATE grants
SET org_entity_id = 'pvJ50HupEQ'
WHERE organization_id = 'pvJ50HupEQ'
  AND org_entity_id IS NULL;

UPDATE grants
SET org_entity_id = 'y4bieqSeag'
WHERE organization_id = 'y4bieqSeag'
  AND org_entity_id IS NULL;

-- ============================================================
-- PERSONNEL
-- ============================================================

-- Legacy column: person_id
UPDATE personnel
SET person_id = 'pvJ50HupEQ', updated_at = now()
WHERE person_id = 'sIFjGbxVct';

UPDATE personnel
SET person_id = 'y4bieqSeag', updated_at = now()
WHERE person_id = 'oa9A0OV0RX';

-- Legacy column: organization_id
UPDATE personnel
SET organization_id = 'pvJ50HupEQ', updated_at = now()
WHERE organization_id = 'sIFjGbxVct';

UPDATE personnel
SET organization_id = 'y4bieqSeag', updated_at = now()
WHERE organization_id = 'oa9A0OV0RX';

-- Resolved FK: person_entity_id
UPDATE personnel
SET person_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE person_entity_id = 'sIFjGbxVct';

UPDATE personnel
SET person_entity_id = 'y4bieqSeag', updated_at = now()
WHERE person_entity_id = 'oa9A0OV0RX';

-- Resolved FK: org_entity_id
UPDATE personnel
SET org_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE org_entity_id = 'sIFjGbxVct';

UPDATE personnel
SET org_entity_id = 'y4bieqSeag', updated_at = now()
WHERE org_entity_id = 'oa9A0OV0RX';

-- Backfill org_entity_id for rows that were missed
UPDATE personnel
SET org_entity_id = 'pvJ50HupEQ'
WHERE organization_id = 'pvJ50HupEQ'
  AND org_entity_id IS NULL;

UPDATE personnel
SET org_entity_id = 'y4bieqSeag'
WHERE organization_id = 'y4bieqSeag'
  AND org_entity_id IS NULL;

-- ============================================================
-- FUNDING ROUNDS
-- ============================================================

-- Legacy column: company_id
UPDATE funding_rounds
SET company_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_id = 'sIFjGbxVct';

UPDATE funding_rounds
SET company_id = 'y4bieqSeag', updated_at = now()
WHERE company_id = 'oa9A0OV0RX';

-- Legacy column: lead_investor
UPDATE funding_rounds
SET lead_investor = 'pvJ50HupEQ', updated_at = now()
WHERE lead_investor = 'sIFjGbxVct';

UPDATE funding_rounds
SET lead_investor = 'y4bieqSeag', updated_at = now()
WHERE lead_investor = 'oa9A0OV0RX';

-- Resolved FK: company_entity_id
UPDATE funding_rounds
SET company_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_entity_id = 'sIFjGbxVct';

UPDATE funding_rounds
SET company_entity_id = 'y4bieqSeag', updated_at = now()
WHERE company_entity_id = 'oa9A0OV0RX';

-- Resolved FK: lead_investor_entity_id
UPDATE funding_rounds
SET lead_investor_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE lead_investor_entity_id = 'sIFjGbxVct';

UPDATE funding_rounds
SET lead_investor_entity_id = 'y4bieqSeag', updated_at = now()
WHERE lead_investor_entity_id = 'oa9A0OV0RX';

-- ============================================================
-- INVESTMENTS
-- ============================================================

-- Legacy column: company_id
UPDATE investments
SET company_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_id = 'sIFjGbxVct';

UPDATE investments
SET company_id = 'y4bieqSeag', updated_at = now()
WHERE company_id = 'oa9A0OV0RX';

-- Legacy column: investor_id
UPDATE investments
SET investor_id = 'pvJ50HupEQ', updated_at = now()
WHERE investor_id = 'sIFjGbxVct';

UPDATE investments
SET investor_id = 'y4bieqSeag', updated_at = now()
WHERE investor_id = 'oa9A0OV0RX';

-- Resolved FK: company_entity_id
UPDATE investments
SET company_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_entity_id = 'sIFjGbxVct';

UPDATE investments
SET company_entity_id = 'y4bieqSeag', updated_at = now()
WHERE company_entity_id = 'oa9A0OV0RX';

-- Resolved FK: investor_entity_id
UPDATE investments
SET investor_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE investor_entity_id = 'sIFjGbxVct';

UPDATE investments
SET investor_entity_id = 'y4bieqSeag', updated_at = now()
WHERE investor_entity_id = 'oa9A0OV0RX';

-- ============================================================
-- EQUITY POSITIONS
-- ============================================================

-- Legacy column: company_id
UPDATE equity_positions
SET company_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_id = 'sIFjGbxVct';

UPDATE equity_positions
SET company_id = 'y4bieqSeag', updated_at = now()
WHERE company_id = 'oa9A0OV0RX';

-- Legacy column: holder_id
UPDATE equity_positions
SET holder_id = 'pvJ50HupEQ', updated_at = now()
WHERE holder_id = 'sIFjGbxVct';

UPDATE equity_positions
SET holder_id = 'y4bieqSeag', updated_at = now()
WHERE holder_id = 'oa9A0OV0RX';

-- Resolved FK: company_entity_id
UPDATE equity_positions
SET company_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE company_entity_id = 'sIFjGbxVct';

UPDATE equity_positions
SET company_entity_id = 'y4bieqSeag', updated_at = now()
WHERE company_entity_id = 'oa9A0OV0RX';

-- Resolved FK: holder_entity_id
UPDATE equity_positions
SET holder_entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE holder_entity_id = 'sIFjGbxVct';

UPDATE equity_positions
SET holder_entity_id = 'y4bieqSeag', updated_at = now()
WHERE holder_entity_id = 'oa9A0OV0RX';

-- ============================================================
-- DIVISIONS
-- ============================================================

-- Legacy column: parent_org_id
UPDATE divisions
SET parent_org_id = 'pvJ50HupEQ', updated_at = now()
WHERE parent_org_id = 'sIFjGbxVct';

UPDATE divisions
SET parent_org_id = 'y4bieqSeag', updated_at = now()
WHERE parent_org_id = 'oa9A0OV0RX';

-- Legacy column: lead (person stableId or display name)
UPDATE divisions
SET lead = 'pvJ50HupEQ', updated_at = now()
WHERE lead = 'sIFjGbxVct';

UPDATE divisions
SET lead = 'y4bieqSeag', updated_at = now()
WHERE lead = 'oa9A0OV0RX';

-- ============================================================
-- FUNDING PROGRAMS
-- ============================================================

-- Legacy column: org_id
UPDATE funding_programs
SET org_id = 'pvJ50HupEQ', updated_at = now()
WHERE org_id = 'sIFjGbxVct';

UPDATE funding_programs
SET org_id = 'y4bieqSeag', updated_at = now()
WHERE org_id = 'oa9A0OV0RX';

-- ============================================================
-- RESEARCH AREA ORGANIZATIONS
-- ============================================================

-- Legacy column: organization_id (part of composite PK)
-- Must handle potential conflict if the canonical ID already exists for
-- the same research_area_id. Delete the stale row first if canonical exists.
DELETE FROM research_area_organizations
WHERE organization_id = 'sIFjGbxVct'
  AND research_area_id IN (
    SELECT research_area_id FROM research_area_organizations
    WHERE organization_id = 'pvJ50HupEQ'
  );

UPDATE research_area_organizations
SET organization_id = 'pvJ50HupEQ'
WHERE organization_id = 'sIFjGbxVct';

DELETE FROM research_area_organizations
WHERE organization_id = 'oa9A0OV0RX'
  AND research_area_id IN (
    SELECT research_area_id FROM research_area_organizations
    WHERE organization_id = 'y4bieqSeag'
  );

UPDATE research_area_organizations
SET organization_id = 'y4bieqSeag'
WHERE organization_id = 'oa9A0OV0RX';

-- ============================================================
-- DIVISION PERSONNEL
-- ============================================================

-- Legacy column: person_id (person stableId or display name)
UPDATE division_personnel
SET person_id = 'pvJ50HupEQ', updated_at = now()
WHERE person_id = 'sIFjGbxVct';

UPDATE division_personnel
SET person_id = 'y4bieqSeag', updated_at = now()
WHERE person_id = 'oa9A0OV0RX';

-- ============================================================
-- FACTS (FactBase mirror)
-- ============================================================

-- entity_id is FK to entities.stable_id. If the stale entity row
-- exists in the entities table, facts might reference it.
-- The facts table has ON DELETE CASCADE, so if the stale entity is
-- later deleted, these facts would be lost. Fix them now.
UPDATE facts
SET entity_id = 'pvJ50HupEQ', updated_at = now()
WHERE entity_id = 'sIFjGbxVct';

UPDATE facts
SET entity_id = 'y4bieqSeag', updated_at = now()
WHERE entity_id = 'oa9A0OV0RX';

-- subject column also references entities.stable_id
UPDATE facts
SET subject = 'pvJ50HupEQ', updated_at = now()
WHERE subject = 'sIFjGbxVct';

UPDATE facts
SET subject = 'y4bieqSeag', updated_at = now()
WHERE subject = 'oa9A0OV0RX';

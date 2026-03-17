-- Fix entity name resolution across all org tables.
-- Migration 0093 only matched on stable_id; this also matches on entities.id
-- (slug) and adds entityType guards to prevent cross-type matches.
-- All tables are small (<500 rows) — runs in milliseconds.

-- ============================================================
-- PERSONNEL
-- ============================================================

-- 1. Strip "new:" prefix → store clean name in person_display_name
UPDATE personnel SET
  person_display_name = trim(substring(person_id FROM 5))
WHERE person_id LIKE 'new:%'
  AND person_display_name IS NULL;

-- 2. Resolve person_entity_id by stableId (with entityType guard)
UPDATE personnel p SET person_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = p.person_id
  AND e.entity_type = 'person'
  AND p.person_entity_id IS NULL
  AND p.person_id NOT LIKE 'new:%';

-- 3. Resolve person_entity_id by slug (entities.id IS the slug)
UPDATE personnel p SET person_entity_id = e.stable_id
FROM entities e
WHERE e.id = p.person_id
  AND e.entity_type = 'person'
  AND p.person_entity_id IS NULL
  AND p.person_id NOT LIKE 'new:%';

-- 4. Resolve org_entity_id by stableId (with entityType guard)
UPDATE personnel p SET org_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = p.organization_id
  AND e.entity_type = 'organization'
  AND p.org_entity_id IS NULL;

-- 5. Resolve org_entity_id by slug
UPDATE personnel p SET org_entity_id = e.stable_id
FROM entities e
WHERE e.id = p.organization_id
  AND e.entity_type = 'organization'
  AND p.org_entity_id IS NULL;

-- 6. Backfill person_display_name for records still unresolved
-- (where personId looks like a human name, not a stableId)
UPDATE personnel SET
  person_display_name = person_id
WHERE person_entity_id IS NULL
  AND person_display_name IS NULL
  AND person_id !~ '^[A-Za-z0-9]{10}$';

-- 7. Backfill org_display_name for unresolved orgs
UPDATE personnel SET
  org_display_name = organization_id
WHERE org_entity_id IS NULL
  AND org_display_name IS NULL
  AND organization_id !~ '^[A-Za-z0-9]{10}$';

-- ============================================================
-- GRANTS — resolve grantee by slug + entityType guard
-- ============================================================

UPDATE grants g SET grantee_entity_id = e.stable_id
FROM entities e
WHERE e.id = g.grantee_id
  AND g.grantee_entity_id IS NULL
  AND g.grantee_id IS NOT NULL;

UPDATE grants g SET grantee_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = g.grantee_id
  AND g.grantee_entity_id IS NULL
  AND g.grantee_id IS NOT NULL;

UPDATE grants SET
  grantee_display_name = grantee_id
WHERE grantee_entity_id IS NULL
  AND grantee_display_name IS NULL
  AND grantee_id IS NOT NULL
  AND grantee_id !~ '^[A-Za-z0-9]{10}$'
  AND grantee_id !~ '^\d+$';

-- Resolve org by slug
UPDATE grants g SET org_entity_id = e.stable_id
FROM entities e
WHERE e.id = g.organization_id
  AND e.entity_type = 'organization'
  AND g.org_entity_id IS NULL;

-- ============================================================
-- FUNDING ROUNDS — resolve lead investor + company by slug
-- ============================================================

UPDATE funding_rounds fr SET lead_investor_entity_id = e.stable_id
FROM entities e
WHERE e.id = fr.lead_investor
  AND fr.lead_investor_entity_id IS NULL
  AND fr.lead_investor IS NOT NULL;

UPDATE funding_rounds fr SET lead_investor_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = fr.lead_investor
  AND fr.lead_investor_entity_id IS NULL
  AND fr.lead_investor IS NOT NULL;

UPDATE funding_rounds SET
  lead_investor_display_name = lead_investor
WHERE lead_investor_entity_id IS NULL
  AND lead_investor_display_name IS NULL
  AND lead_investor IS NOT NULL
  AND lead_investor !~ '^[A-Za-z0-9]{10}$';

UPDATE funding_rounds fr SET company_entity_id = e.stable_id
FROM entities e
WHERE e.id = fr.company_id
  AND e.entity_type = 'organization'
  AND fr.company_entity_id IS NULL;

-- ============================================================
-- INVESTMENTS — resolve investor + company by slug
-- ============================================================

UPDATE investments inv SET investor_entity_id = e.stable_id
FROM entities e
WHERE e.id = inv.investor_id
  AND inv.investor_entity_id IS NULL;

UPDATE investments inv SET investor_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = inv.investor_id
  AND inv.investor_entity_id IS NULL;

UPDATE investments SET
  investor_display_name = investor_id
WHERE investor_entity_id IS NULL
  AND investor_display_name IS NULL
  AND investor_id !~ '^[A-Za-z0-9]{10}$';

UPDATE investments inv SET company_entity_id = e.stable_id
FROM entities e
WHERE e.id = inv.company_id
  AND e.entity_type = 'organization'
  AND inv.company_entity_id IS NULL;

-- ============================================================
-- EQUITY POSITIONS — resolve holder + company by slug
-- ============================================================

UPDATE equity_positions ep SET holder_entity_id = e.stable_id
FROM entities e
WHERE e.id = ep.holder_id
  AND ep.holder_entity_id IS NULL;

UPDATE equity_positions ep SET holder_entity_id = e.stable_id
FROM entities e
WHERE e.stable_id = ep.holder_id
  AND ep.holder_entity_id IS NULL;

UPDATE equity_positions SET
  holder_display_name = holder_id
WHERE holder_entity_id IS NULL
  AND holder_display_name IS NULL
  AND holder_id !~ '^[A-Za-z0-9]{10}$';

UPDATE equity_positions ep SET company_entity_id = e.stable_id
FROM entities e
WHERE e.id = ep.company_id
  AND e.entity_type = 'organization'
  AND ep.company_entity_id IS NULL;

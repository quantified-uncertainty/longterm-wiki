-- Backfill parent_title and description for existing things rows.
-- Run after migration 0104 deploys:
--   psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/backfill-things-parent-title.sql
-- Idempotent: only updates rows where parent_title IS NULL.

-- ── Grants: parent_title = funder org slug, description = recipient + amount ──
UPDATE things t SET
  parent_title = g.organization_id,
  description = NULLIF(CONCAT_WS(', ',
    CASE WHEN g.grantee_id IS NOT NULL THEN 'to ' || g.grantee_id END,
    CASE WHEN g.amount IS NOT NULL THEN '$' || g.amount::bigint::text END,
    g.date
  ), '')
FROM grants g
WHERE t.source_table = 'grants' AND t.source_id = g.id AND t.parent_title IS NULL;

-- ── Funding Rounds: parent_title = company slug ──
UPDATE things t SET
  parent_title = fr.company_id,
  description = NULLIF(CONCAT_WS(', ',
    CASE WHEN fr.raised IS NOT NULL THEN 'raised $' || fr.raised::bigint::text END,
    fr.instrument,
    CASE WHEN fr.lead_investor IS NOT NULL THEN 'led by ' || fr.lead_investor END
  ), '')
FROM funding_rounds fr
WHERE t.source_table = 'funding_rounds' AND t.source_id = fr.id AND t.parent_title IS NULL;

-- ── Funding Programs: parent_title = org slug ──
UPDATE things t SET parent_title = fp.org_id
FROM funding_programs fp
WHERE t.source_table = 'funding_programs' AND t.source_id = fp.id AND t.parent_title IS NULL;

-- ── Divisions: parent_title = parent org slug ──
UPDATE things t SET
  parent_title = d.parent_org_id,
  description = d.division_type
FROM divisions d
WHERE t.source_table = 'divisions' AND t.source_id = d.id AND t.parent_title IS NULL;

-- Report
SELECT source_table, count(*) AS total,
  count(parent_title) AS has_parent_title,
  count(description) AS has_description
FROM things
GROUP BY source_table
ORDER BY source_table;

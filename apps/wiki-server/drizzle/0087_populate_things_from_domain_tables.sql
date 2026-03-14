-- Populate the things table from all existing domain tables.
-- This is idempotent — uses ON CONFLICT DO NOTHING so it can be re-run safely.

-- 1. Entities (use stableId when available, fall back to slug)
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, entity_type, description, numeric_id, created_at, updated_at, synced_at)
SELECT
  COALESCE(e.stable_id, e.id),
  'entity',
  e.title,
  NULL,
  'entities',
  e.id,
  e.entity_type,
  e.description,
  e.numeric_id,
  e.created_at,
  e.updated_at,
  e.synced_at
FROM entities e
ON CONFLICT (id) DO NOTHING;

-- 2. Resources (use stableId when available, fall back to id)
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, description, source_url, created_at, updated_at, synced_at)
SELECT
  COALESCE(r.stable_id, r.id),
  'resource',
  COALESCE(r.title, r.url),
  NULL,
  'resources',
  r.id,
  r.summary,
  r.url,
  r.created_at,
  r.updated_at,
  NOW()
FROM resources r
ON CONFLICT (id) DO NOTHING;

-- 3. Grants
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  g.id,
  'grant',
  g.name,
  -- Link to parent org thing (look up by source_id = organizationId)
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = g.organization_id LIMIT 1),
  'grants',
  g.id,
  g.source,
  g.created_at,
  g.updated_at,
  g.synced_at
FROM grants g
ON CONFLICT (id) DO NOTHING;

-- 4. Personnel
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  p.id,
  'personnel',
  p.person_id || ' — ' || p.role || ' at ' || p.organization_id,
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = p.organization_id LIMIT 1),
  'personnel',
  p.id,
  p.source,
  p.created_at,
  p.updated_at,
  p.synced_at
FROM personnel p
ON CONFLICT (id) DO NOTHING;

-- 5. Divisions
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  d.id,
  'division',
  d.name,
  -- Link to parent org (stored as stableId in parent_org_id)
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND (t.source_id = d.parent_org_id OR t.id = d.parent_org_id) LIMIT 1),
  'divisions',
  d.id,
  d.website,
  d.created_at,
  d.updated_at,
  d.synced_at
FROM divisions d
ON CONFLICT (id) DO NOTHING;

-- 6. Funding rounds
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  fr.id,
  'funding-round',
  fr.name || COALESCE(' (' || fr.date || ')', ''),
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = fr.company_id LIMIT 1),
  'funding_rounds',
  fr.id,
  fr.source,
  fr.created_at,
  fr.updated_at,
  fr.synced_at
FROM funding_rounds fr
ON CONFLICT (id) DO NOTHING;

-- 7. Investments
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  i.id,
  'investment',
  i.investor_id || ' → ' || i.company_id || COALESCE(' (' || i.round_name || ')', ''),
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = i.company_id LIMIT 1),
  'investments',
  i.id,
  i.source,
  i.created_at,
  i.updated_at,
  i.synced_at
FROM investments i
ON CONFLICT (id) DO NOTHING;

-- 8. Equity positions
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  ep.id,
  'equity-position',
  ep.holder_id || ' stake in ' || ep.company_id,
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND t.source_id = ep.company_id LIMIT 1),
  'equity_positions',
  ep.id,
  ep.source,
  ep.created_at,
  ep.updated_at,
  ep.synced_at
FROM equity_positions ep
ON CONFLICT (id) DO NOTHING;

-- 9. Benchmarks
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, description, source_url, created_at, updated_at, synced_at)
SELECT
  b.id,
  'benchmark',
  b.name,
  NULL,
  'benchmarks',
  b.id,
  b.description,
  b.website,
  b.created_at,
  b.updated_at,
  b.synced_at
FROM benchmarks b
ON CONFLICT (id) DO NOTHING;

-- 10. Benchmark results
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  br.id,
  'benchmark-result',
  br.model_id || ' on ' || br.benchmark_id || ': ' || br.score::text,
  (SELECT t.id FROM things t WHERE t.source_table = 'benchmarks' AND t.source_id = br.benchmark_id LIMIT 1),
  'benchmark_results',
  br.id,
  br.source_url,
  br.created_at,
  br.updated_at,
  br.synced_at
FROM benchmark_results br
ON CONFLICT (id) DO NOTHING;

-- 11. Funding programs
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  fp.id,
  'funding-program',
  fp.name,
  -- Link to parent org (stored as stableId in org_id)
  (SELECT t.id FROM things t WHERE t.source_table = 'entities' AND (t.source_id = fp.org_id OR t.id = fp.org_id) LIMIT 1),
  'funding_programs',
  fp.id,
  fp.source,
  fp.created_at,
  fp.updated_at,
  fp.synced_at
FROM funding_programs fp
ON CONFLICT (id) DO NOTHING;

-- 12. Division personnel
INSERT INTO things (id, thing_type, title, parent_thing_id, source_table, source_id, source_url, created_at, updated_at, synced_at)
SELECT
  dp.id,
  'division-personnel',
  dp.person_id || ' — ' || dp.role,
  (SELECT t.id FROM things t WHERE t.source_table = 'divisions' AND t.source_id = dp.division_id LIMIT 1),
  'division_personnel',
  dp.id,
  dp.source,
  dp.created_at,
  dp.updated_at,
  dp.synced_at
FROM division_personnel dp
ON CONFLICT (id) DO NOTHING;

-- 13. Backfill verdicts from record_verdicts into things
UPDATE things t
SET
  verdict = rv.verdict,
  verdict_confidence = rv.confidence,
  verdict_at = rv.last_computed_at
FROM record_verdicts rv
WHERE t.source_table = (
  CASE rv.record_type
    WHEN 'grant' THEN 'grants'
    WHEN 'personnel' THEN 'personnel'
    WHEN 'division' THEN 'divisions'
    WHEN 'funding-program' THEN 'funding_programs'
    WHEN 'funding-round' THEN 'funding_rounds'
    WHEN 'investment' THEN 'investments'
    WHEN 'equity-position' THEN 'equity_positions'
  END
)
AND t.source_id = rv.record_id;

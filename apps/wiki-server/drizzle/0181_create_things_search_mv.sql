-- QUA-506 Phase 4b-B.2b: create things_search materialized view + indexes.
--
-- Parent: QUA-408 / docs/audits/things-denormalization-audit.md.
-- Predecessor: QUA-476 (benchmark-only, docs/benchmarks/qua-476/).
-- This phase: QUA-506 D1 benchmark (docs/benchmarks/qua-506/) cleared all four
-- abort thresholds — see §6 of docs/benchmarks/qua-506/README.md.
--
-- WHAT THIS DOES
--
-- Creates `things_search`, a materialized view that composes title /
-- description / parent_title from the source tables (entities, facts, grants,
-- …) rather than re-reading the denormalized columns on `things`. Adds a
-- stored `search_vector` tsvector column computed inline, a UNIQUE index on
-- `id` (required for REFRESH CONCURRENTLY), and the same secondary btrees
-- `things` carries today so the read-path switch in /api/things/{search,
-- list, children, :id} and /api/people can flip FROM clauses without query
-- rewrites.
--
-- WHAT THIS DOES NOT DO
--
-- - Does NOT drop `things.title`, `things.description`, `things.parent_title`,
--   or the generated `things.search_vector` column. Writers keep populating
--   them. This is QUA-507's cut.
-- - Does NOT switch the sync handlers or the composer dispatch table
--   (QUA-470) from write-time to refresh-time. That's QUA-506c.
-- - Does NOT enable pg_trgm on the MV. The trigram fallback in
--   /api/things/search phase 3 stays on `things` for now; decision deferred
--   per the QUA-506 scope.
--
-- TIMING
--
-- Benchmarked on prod 2026-04-15:
-- - CREATE MV + WITH NO DATA: 97 ms
-- - Initial populate REFRESH: ~9 s (first run); subsequent refreshes ~14-19 s
-- - Index builds: ~4 s total
-- - Total initial build: ~14 s (well under the migration-client lock_timeout
--   of 60 s — no NOT VALID / VALIDATE CONSTRAINT pattern needed)
--
-- IDEMPOTENCY
--
-- All statements use IF NOT EXISTS / IF EXISTS. Safe to re-run. If a prior
-- run left a partial MV behind, the leading DROP MATERIALIZED VIEW IF EXISTS
-- will clean it up first.
--
-- DROP first so re-runs don't fail on conflicting definitions. In the
-- happy path on a fresh prod, this is a no-op.
DROP MATERIALIZED VIEW IF EXISTS things_search;

-- Create the MV. The inner SELECT is a UNION ALL across 21 source-table
-- branches; the outer SELECT adds the stored search_vector column computed
-- from base.title / parent_title / description / thing_type / entity_type
-- using the same weighted expression as the current
-- `idx_things_search` GIN on things.
CREATE MATERIALIZED VIEW things_search AS
SELECT
  base.id,
  base.thing_type,
  base.title,
  base.parent_thing_id,
  base.source_table,
  base.source_id,
  base.entity_type,
  base.description,
  base.source_url,
  base.wiki_id,
  base.parent_title,
  base.created_at,
  base.updated_at,
  base.synced_at,
  (
    setweight(to_tsvector('english', coalesce(base.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(base.parent_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(base.description, '')), 'C') ||
    setweight(to_tsvector('english',
      coalesce(replace(base.thing_type, '-', ' '), '') || ' ' ||
      coalesce(replace(base.entity_type, '-', ' '), '')
    ), 'D')
  ) AS search_vector
FROM (

  -- 1. entity (from entities)
  SELECT
    e.stable_id::text   AS id,
    'entity'::text      AS thing_type,
    e.title             AS title,
    NULL::text          AS parent_thing_id,
    'entities'::text    AS source_table,
    e.id::text          AS source_id,
    e.entity_type       AS entity_type,
    e.description       AS description,
    e.website           AS source_url,
    e.wiki_id           AS wiki_id,
    NULL::text          AS parent_title,
    e.created_at        AS created_at,
    e.updated_at        AS updated_at,
    e.synced_at         AS synced_at
  FROM entities e

  UNION ALL

  -- 2. fact (from facts LEFT JOIN entities)
  SELECT
    f.fact_id::text                                        AS id,
    'fact'::text                                           AS thing_type,
    (COALESCE(f.label, f.measure, 'fact') || ' — ' ||
      COALESCE(e.title, f.entity_id))                      AS title,
    f.entity_id                                            AS parent_thing_id,
    'facts'::text                                          AS source_table,
    f.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    CASE
      WHEN f.value IS NOT NULL
        THEN COALESCE(f.label, f.measure, 'fact') || ': ' || f.value
      WHEN f.numeric IS NOT NULL
        THEN COALESCE(f.label, f.measure, 'fact') || ': ' || f.numeric::text
      ELSE NULL
    END                                                    AS description,
    f.source                                               AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(e.title, f.entity_id)                         AS parent_title,
    f.created_at                                           AS created_at,
    f.updated_at                                           AS updated_at,
    f.synced_at                                            AS synced_at
  FROM facts f
  LEFT JOIN entities e ON e.stable_id = f.entity_id

  UNION ALL

  -- 3. grant (from grants LEFT JOIN entities x2 — org + grantee)
  SELECT
    g.id::text                                             AS id,
    'grant'::text                                          AS thing_type,
    g.name                                                 AS title,
    g.organization_id                                      AS parent_thing_id,
    'grants'::text                                         AS source_table,
    g.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    NULLIF(
      CONCAT_WS(', ',
        CASE
          WHEN g.grantee_id IS NOT NULL
            THEN 'to ' || COALESCE(ge.title, g.grantee_id)
          ELSE NULL
        END,
        CASE
          WHEN g.amount IS NOT NULL
            THEN COALESCE(g.currency, 'USD') || ' ' || g.amount::text
          ELSE NULL
        END,
        g.date
      ),
      ''
    )                                                      AS description,
    g.source                                               AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(oe.title, g.organization_id)                  AS parent_title,
    g.created_at                                           AS created_at,
    g.updated_at                                           AS updated_at,
    g.synced_at                                            AS synced_at
  FROM grants g
  LEFT JOIN entities oe ON oe.stable_id = g.organization_id
  LEFT JOIN entities ge ON ge.stable_id = g.grantee_id

  UNION ALL

  -- 4. personnel (from personnel LEFT JOIN entities x2)
  SELECT
    p.id::text                                             AS id,
    'personnel'::text                                      AS thing_type,
    (
      COALESCE(pe.title, p.person_display_name, p.person_id) || ' — ' || p.role ||
      ' at ' || COALESCE(oe.title, p.organization_id)
    )                                                      AS title,
    NULL::text                                             AS parent_thing_id,
    'personnel'::text                                      AS source_table,
    p.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    p.source                                               AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(oe.title, p.organization_id)                  AS parent_title,
    p.created_at                                           AS created_at,
    p.updated_at                                           AS updated_at,
    p.synced_at                                            AS synced_at
  FROM personnel p
  LEFT JOIN entities pe ON pe.stable_id = p.person_entity_id
  LEFT JOIN entities oe ON oe.stable_id = p.organization_id

  UNION ALL

  -- 5. resource (from resources)
  SELECT
    r.id::text                                             AS id,
    'resource'::text                                       AS thing_type,
    COALESCE(r.title, r.url)                               AS title,
    NULL::text                                             AS parent_thing_id,
    'resources'::text                                      AS source_table,
    r.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    r.summary                                              AS description,
    r.url                                                  AS source_url,
    NULL::text                                             AS wiki_id,
    NULL::text                                             AS parent_title,
    r.created_at                                           AS created_at,
    r.updated_at                                           AS updated_at,
    NULL::timestamptz                                      AS synced_at
  FROM resources r

  UNION ALL

  -- 6. equity-position (from equity_positions LEFT JOIN entities x2)
  SELECT
    ep.id::text                                            AS id,
    'equity-position'::text                                AS thing_type,
    (
      COALESCE(he.title, ep.holder_id) || ' stake in ' ||
      COALESCE(ce.title, ep.company_id)
    )                                                      AS title,
    ep.company_id                                          AS parent_thing_id,
    'equity_positions'::text                               AS source_table,
    ep.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    ep.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(ce.title, ep.company_id)                      AS parent_title,
    ep.created_at                                          AS created_at,
    ep.updated_at                                          AS updated_at,
    ep.synced_at                                           AS synced_at
  FROM equity_positions ep
  LEFT JOIN entities he ON he.stable_id = ep.holder_id
  LEFT JOIN entities ce ON ce.stable_id = ep.company_id

  UNION ALL

  -- 7. political-race (from political_races)
  SELECT
    pr.id::text                                            AS id,
    'political-race'::text                                 AS thing_type,
    pr.name                                                AS title,
    NULL::text                                             AS parent_thing_id,
    'political_races'::text                                AS source_table,
    pr.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    pr.ai_angle                                            AS description,
    pr.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    pr.state                                               AS parent_title,
    pr.created_at                                          AS created_at,
    pr.updated_at                                          AS updated_at,
    pr.synced_at                                           AS synced_at
  FROM political_races pr

  UNION ALL

  -- 8. race-candidate (from race_candidates LEFT JOIN political_races)
  SELECT
    rc.id::text                                            AS id,
    'race-candidate'::text                                 AS thing_type,
    rc.candidate_display_name                              AS title,
    rc.race_id                                             AS parent_thing_id,
    'race_candidates'::text                                AS source_table,
    rc.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    rc.ai_stance                                           AS description,
    rc.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    pr2.name                                               AS parent_title,
    rc.created_at                                          AS created_at,
    rc.updated_at                                          AS updated_at,
    rc.synced_at                                           AS synced_at
  FROM race_candidates rc
  LEFT JOIN political_races pr2 ON pr2.id = rc.race_id

  UNION ALL

  -- 9. entity-resource (from entity_resources LEFT JOIN entities + resources)
  SELECT
    er.id::text                                            AS id,
    'entity-resource'::text                                AS thing_type,
    COALESCE(res.title, res.url, er.resource_id)           AS title,
    er.entity_id                                           AS parent_thing_id,
    'entity_resources'::text                               AS source_table,
    er.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    CASE
      WHEN er.authored_by_entity THEN 'authored'
      WHEN er.is_subject THEN 'about'
      ELSE 'linked'
    END                                                    AS description,
    res.url                                                AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(ee.title, er.entity_id)                       AS parent_title,
    er.created_at                                          AS created_at,
    NULL::timestamptz                                      AS updated_at,
    NULL::timestamptz                                      AS synced_at
  FROM entity_resources er
  LEFT JOIN entities ee ON ee.stable_id = er.entity_id
  LEFT JOIN resources res ON res.id = er.resource_id

  UNION ALL

  -- 10. entity-assessment (from entity_assessments LEFT JOIN entities)
  SELECT
    ea.id::text                                            AS id,
    'entity-assessment'::text                              AS thing_type,
    (ea.dimension || ': ' || ea.rating)                    AS title,
    ea.entity_id                                           AS parent_thing_id,
    'entity_assessments'::text                             AS source_table,
    ea.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    ea.evidence                                            AS description,
    ea.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(ae.title, ea.entity_id)                       AS parent_title,
    ea.created_at                                          AS created_at,
    ea.updated_at                                          AS updated_at,
    ea.synced_at                                           AS synced_at
  FROM entity_assessments ea
  LEFT JOIN entities ae ON ae.stable_id = ea.entity_id

  UNION ALL

  -- 11. research-area (from research_areas)
  SELECT
    ra.id::text                                            AS id,
    'research-area'::text                                  AS thing_type,
    ra.title                                               AS title,
    NULL::text                                             AS parent_thing_id,
    'research_areas'::text                                 AS source_table,
    ra.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    ra.description                                         AS description,
    ra.source                                              AS source_url,
    ra.wiki_id                                             AS wiki_id,
    NULL::text                                             AS parent_title,
    ra.created_at                                          AS created_at,
    ra.updated_at                                          AS updated_at,
    ra.synced_at                                           AS synced_at
  FROM research_areas ra

  UNION ALL

  -- 12. investment (from investments LEFT JOIN entities x2)
  SELECT
    i.id::text                                             AS id,
    'investment'::text                                     AS thing_type,
    (
      COALESCE(ie.title, i.investor_id) || ' → ' ||
      COALESCE(ce.title, i.company_id) ||
      COALESCE(' (' || i.round_name || ')', '')
    )                                                      AS title,
    i.company_id                                           AS parent_thing_id,
    'investments'::text                                    AS source_table,
    i.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    i.source                                               AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(ce.title, i.company_id)                       AS parent_title,
    i.created_at                                           AS created_at,
    i.updated_at                                           AS updated_at,
    i.synced_at                                            AS synced_at
  FROM investments i
  LEFT JOIN entities ie ON ie.stable_id = i.investor_id
  LEFT JOIN entities ce ON ce.stable_id = i.company_id

  UNION ALL

  -- 13. policy-stakeholder (from policy_stakeholders LEFT JOIN entities)
  SELECT
    ps.id::text                                            AS id,
    'policy-stakeholder'::text                             AS thing_type,
    (
      ps.stakeholder_display_name || ' on ' ||
      COALESCE(pe2.title, ps.policy_entity_id)
    )                                                      AS title,
    ps.policy_entity_id                                    AS parent_thing_id,
    'policy_stakeholders'::text                            AS source_table,
    ps.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    ps.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(pe2.title, ps.policy_entity_id)               AS parent_title,
    ps.created_at                                          AS created_at,
    ps.updated_at                                          AS updated_at,
    ps.synced_at                                           AS synced_at
  FROM policy_stakeholders ps
  LEFT JOIN entities pe2 ON pe2.stable_id = ps.policy_entity_id

  UNION ALL

  -- 14. benchmark-result (from benchmark_results LEFT JOIN entities + benchmarks)
  SELECT
    br.id::text                                            AS id,
    'benchmark-result'::text                               AS thing_type,
    (
      COALESCE(me.title, br.model_id) || ' on ' ||
      COALESCE(bm.name, br.benchmark_id) || ': ' || br.score::text
    )                                                      AS title,
    br.benchmark_id                                        AS parent_thing_id,
    'benchmark_results'::text                              AS source_table,
    br.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    br.source_url                                          AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(bm.name, br.benchmark_id)                     AS parent_title,
    br.created_at                                          AS created_at,
    br.updated_at                                          AS updated_at,
    br.synced_at                                           AS synced_at
  FROM benchmark_results br
  LEFT JOIN entities me ON me.stable_id = br.model_id
  LEFT JOIN benchmarks bm ON bm.id = br.benchmark_id

  UNION ALL

  -- 15. benchmark (from benchmarks)
  SELECT
    b.id::text                                             AS id,
    'benchmark'::text                                      AS thing_type,
    b.name                                                 AS title,
    NULL::text                                             AS parent_thing_id,
    'benchmarks'::text                                     AS source_table,
    b.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    b.description                                          AS description,
    b.website                                              AS source_url,
    b.slug                                                 AS wiki_id,
    NULL::text                                             AS parent_title,
    b.created_at                                           AS created_at,
    b.updated_at                                           AS updated_at,
    b.synced_at                                            AS synced_at
  FROM benchmarks b

  UNION ALL

  -- 16. entity-event (from entity_events LEFT JOIN entities)
  SELECT
    ev.id::text                                            AS id,
    'entity-event'::text                                   AS thing_type,
    (ev.title || ' (' || ev.date || ')')                   AS title,
    ev.entity_id                                           AS parent_thing_id,
    'entity_events'::text                                  AS source_table,
    ev.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    ev.description                                         AS description,
    ev.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(eve.title, ev.entity_id)                      AS parent_title,
    ev.created_at                                          AS created_at,
    ev.updated_at                                          AS updated_at,
    ev.synced_at                                           AS synced_at
  FROM entity_events ev
  LEFT JOIN entities eve ON eve.stable_id = ev.entity_id

  UNION ALL

  -- 17. division (from divisions LEFT JOIN entities)
  SELECT
    d.id::text                                             AS id,
    'division'::text                                       AS thing_type,
    d.name                                                 AS title,
    d.parent_org_id                                        AS parent_thing_id,
    'divisions'::text                                      AS source_table,
    d.id::text                                             AS source_id,
    NULL::text                                             AS entity_type,
    d.division_type                                        AS description,
    d.website                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(de.title, d.parent_org_id)                    AS parent_title,
    d.created_at                                           AS created_at,
    d.updated_at                                           AS updated_at,
    d.synced_at                                            AS synced_at
  FROM divisions d
  LEFT JOIN entities de ON de.stable_id = d.parent_org_id

  UNION ALL

  -- 18. funding-round (from funding_rounds LEFT JOIN entities)
  SELECT
    fr.id::text                                            AS id,
    'funding-round'::text                                  AS thing_type,
    (fr.name || COALESCE(' (' || fr.date || ')', ''))      AS title,
    fr.company_id                                          AS parent_thing_id,
    'funding_rounds'::text                                 AS source_table,
    fr.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    fr.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(fce.title, fr.company_display_name, fr.company_id) AS parent_title,
    fr.created_at                                          AS created_at,
    fr.updated_at                                          AS updated_at,
    fr.synced_at                                           AS synced_at
  FROM funding_rounds fr
  LEFT JOIN entities fce ON fce.stable_id = fr.company_id

  UNION ALL

  -- 19. funding-program (from funding_programs LEFT JOIN entities)
  SELECT
    fp.id::text                                            AS id,
    'funding-program'::text                                AS thing_type,
    fp.name                                                AS title,
    fp.org_id                                              AS parent_thing_id,
    'funding_programs'::text                               AS source_table,
    fp.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    fp.description                                         AS description,
    fp.application_url                                     AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(fpe.title, fp.org_id)                         AS parent_title,
    fp.created_at                                          AS created_at,
    fp.updated_at                                          AS updated_at,
    fp.synced_at                                           AS synced_at
  FROM funding_programs fp
  LEFT JOIN entities fpe ON fpe.stable_id = fp.org_id

  UNION ALL

  -- 20. division-personnel (from division_personnel LEFT JOIN entities)
  SELECT
    dp.id::text                                            AS id,
    'division-personnel'::text                             AS thing_type,
    (COALESCE(dpe.title, dp.person_display_name, dp.person_id) || ' — ' || dp.role) AS title,
    dp.division_id                                         AS parent_thing_id,
    'division_personnel'::text                             AS source_table,
    dp.id::text                                            AS source_id,
    NULL::text                                             AS entity_type,
    NULL::text                                             AS description,
    dp.source                                              AS source_url,
    NULL::text                                             AS wiki_id,
    NULL::text                                             AS parent_title,
    dp.created_at                                          AS created_at,
    dp.updated_at                                          AS updated_at,
    dp.synced_at                                           AS synced_at
  FROM division_personnel dp
  LEFT JOIN entities dpe ON dpe.stable_id = dp.person_id

  UNION ALL

  -- 21. publication (from publications LEFT JOIN entities)
  SELECT
    pub.id::text                                           AS id,
    'publication'::text                                    AS thing_type,
    pub.title                                              AS title,
    pub.entity_id                                          AS parent_thing_id,
    'publications'::text                                   AS source_table,
    pub.id::text                                           AS source_id,
    NULL::text                                             AS entity_type,
    NULLIF(CONCAT_WS(', ', pub.authors, pub.venue, pub.published_date), '') AS description,
    pub.url                                                AS source_url,
    NULL::text                                             AS wiki_id,
    COALESCE(pue.title, pub.entity_display_name, pub.entity_id) AS parent_title,
    pub.created_at                                         AS created_at,
    pub.updated_at                                         AS updated_at,
    pub.synced_at                                          AS synced_at
  FROM publications pub
  LEFT JOIN entities pue ON pue.stable_id = pub.entity_id

) AS base
WITH NO DATA;

-- Populate the MV. First refresh must be non-concurrent per the
-- CONCURRENTLY-requires-populated-MV rule.
REFRESH MATERIALIZED VIEW things_search;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX things_search_pkey ON things_search (id);

-- Full-text search GIN index — mirrors idx_things_search on the base table.
CREATE INDEX things_search_gin ON things_search USING GIN (search_vector);

-- Secondary btree indexes — mirrors the current `things` secondary index set
-- so /api/things/{list,children,:id} can switch with no query rewrites.
CREATE INDEX things_search_type_idx        ON things_search (thing_type);
CREATE INDEX things_search_parent_idx      ON things_search (parent_thing_id);
CREATE INDEX things_search_entity_type_idx ON things_search (entity_type);
CREATE INDEX things_search_updated_idx     ON things_search (updated_at);

-- Refresh planner stats so the secondary btrees have row counts.
ANALYZE things_search;

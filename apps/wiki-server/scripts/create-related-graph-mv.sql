-- Materialized view: precomputed related-page graph.
-- Aggregates bidirectional link signals from page_links into ranked related
-- entities per page. Refreshed after each syncPageLinks() call.
--
-- Depends on source_id / target_id integer columns on page_links (renamed from
-- source_id_int / target_id_int by phase-d3e-pk-swap.sql; originally added by phase4a-manual-migration.sql).
-- Apply with: psql "$DATABASE_MIGRATION_URL" -f apps/wiki-server/scripts/create-related-graph-mv.sql

CREATE MATERIALIZED VIEW IF NOT EXISTS wikibase_related_graph AS
WITH edge_scores AS (
  SELECT source_id, target_id, SUM(weight) AS score
  FROM page_links
  WHERE source_id IS NOT NULL AND target_id IS NOT NULL
  GROUP BY source_id, target_id
),
bidirectional AS (
  SELECT source_id AS entity_id, target_id AS related_id, score FROM edge_scores
  UNION ALL
  SELECT target_id AS entity_id, source_id AS related_id, score FROM edge_scores
),
ranked AS (
  SELECT entity_id, related_id, SUM(score) AS total_score,
    ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY SUM(score) DESC) AS rank
  FROM bidirectional
  WHERE entity_id != related_id
  GROUP BY entity_id, related_id
)
SELECT entity_id, related_id, total_score, rank::int
FROM ranked
WHERE rank <= 25;

-- Fast lookup by entity_id + rank (unique because ROW_NUMBER is unique per partition)
CREATE UNIQUE INDEX IF NOT EXISTS idx_related_graph_entity_rank
  ON wikibase_related_graph (entity_id, rank);

-- Also index related_id for reverse lookups (backlink-style queries)
CREATE INDEX IF NOT EXISTS idx_related_graph_related_id
  ON wikibase_related_graph (related_id);

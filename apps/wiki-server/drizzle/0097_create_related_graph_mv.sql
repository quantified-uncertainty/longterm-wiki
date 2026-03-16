-- Materialized view: precomputed related-page graph.
-- Aggregates bidirectional link signals from page_links into ranked related
-- entities per page. Refreshed after each syncPageLinks() call.
--
-- page_links has ~5,000 rows, so this completes instantly and does not need
-- the manual-migration pattern.

CREATE MATERIALIZED VIEW IF NOT EXISTS wikibase_related_graph AS
WITH edge_scores AS (
  SELECT source_id_int, target_id_int, SUM(weight) AS score
  FROM page_links
  WHERE source_id_int IS NOT NULL AND target_id_int IS NOT NULL
  GROUP BY source_id_int, target_id_int
),
bidirectional AS (
  SELECT source_id_int AS entity_id, target_id_int AS related_id, score FROM edge_scores
  UNION ALL
  SELECT target_id_int AS entity_id, source_id_int AS related_id, score FROM edge_scores
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

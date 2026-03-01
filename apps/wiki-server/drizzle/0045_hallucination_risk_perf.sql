-- Covering index for DISTINCT ON (page_id) queries on hallucination_risk_snapshots.
-- Enables index-only scans by including all columns read by /latest and /stats endpoints.
-- Replaces the basic (page_id, computed_at DESC) index from 0014_query_performance.sql.
CREATE INDEX IF NOT EXISTS idx_hrs_page_computed_covering
  ON hallucination_risk_snapshots (page_id, computed_at DESC)
  INCLUDE (id, score, level, factors, integrity_issues);
--> statement-breakpoint

-- Materialized view: latest snapshot per page.
-- Eliminates the expensive DISTINCT ON full-table scan from the /latest and /stats hot paths.
CREATE MATERIALIZED VIEW IF NOT EXISTS hallucination_risk_latest AS
SELECT DISTINCT ON (page_id)
  id, page_id, score, level, factors, integrity_issues, computed_at
FROM hallucination_risk_snapshots
ORDER BY page_id, computed_at DESC;
--> statement-breakpoint

-- Unique index on the materialized view for REFRESH CONCURRENTLY support.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hrl_page_id
  ON hallucination_risk_latest (page_id);
--> statement-breakpoint

-- Index on score for ORDER BY score DESC queries in /latest endpoint.
CREATE INDEX IF NOT EXISTS idx_hrl_score
  ON hallucination_risk_latest (score DESC);
--> statement-breakpoint

-- Index on level for filtered /latest?level=X queries.
CREATE INDEX IF NOT EXISTS idx_hrl_level
  ON hallucination_risk_latest (level);

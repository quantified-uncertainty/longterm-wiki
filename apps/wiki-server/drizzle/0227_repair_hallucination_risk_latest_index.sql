-- Production's latest-risk view has 779 rows and no indexes. Without a
-- unique index, REFRESH CONCURRENTLY fails and falls back to blocking reads.
-- DISTINCT ON (page_id) in the view definition guarantees one row per page,
-- including the existing NULL page row. No deduplication or data rewrite is
-- needed. This indexes the small latest view, not the multi-million-row
-- snapshot history, and restores the index originally defined in 0045.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_hrl_page_id"
  ON "hallucination_risk_latest" ("page_id");

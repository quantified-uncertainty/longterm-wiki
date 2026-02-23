-- Store intermediate artifacts from V2 orchestrator and page-improver pipeline runs.
-- NOTE: Renamed to page_improve_runs in 0023_rename_improve_run_artifacts.sql.
-- Each row captures the full context of a single improvement run: research sources,
-- citation audits, cost tracking, section-level diffs, and quality gate results.
-- See GitHub issue #826.

CREATE TABLE IF NOT EXISTS improve_run_artifacts (
  id            BIGSERIAL PRIMARY KEY,
  page_id       TEXT NOT NULL,
  engine        TEXT NOT NULL,          -- 'v1' (page-improver) or 'v2' (orchestrator)
  tier          TEXT NOT NULL,          -- 'polish', 'standard', 'deep'
  directions    TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  duration_s    REAL,
  total_cost    REAL,

  -- Research artifacts
  source_cache  JSONB,                  -- Array of SourceCacheEntry objects
  research_summary TEXT,                -- Human-readable summary of research findings

  -- Citation audit artifacts
  citation_audit JSONB,                 -- Full AuditResult (per-citation verdicts + summary)

  -- Cost tracking
  cost_entries  JSONB,                  -- Array of {toolName, estimatedCost, timestamp}
  cost_breakdown JSONB,                 -- Record<toolName, totalCost>

  -- Section-level diffs
  section_diffs JSONB,                  -- Array of {sectionId, before, after} (truncated)

  -- Quality gate
  quality_metrics JSONB,                -- QualityMetrics object
  quality_gate_passed BOOLEAN,
  quality_gaps  JSONB,                  -- Array of gap strings

  -- Pipeline metadata
  tool_call_count INTEGER,
  refinement_cycles INTEGER,
  phases_run    JSONB,                  -- Array of phase names (v1 only)

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ira_page_id ON improve_run_artifacts (page_id);
CREATE INDEX idx_ira_engine ON improve_run_artifacts (engine);
CREATE INDEX idx_ira_started_at ON improve_run_artifacts (started_at);
CREATE INDEX idx_ira_page_started ON improve_run_artifacts (page_id, started_at DESC);

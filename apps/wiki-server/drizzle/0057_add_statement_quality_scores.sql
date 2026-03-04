-- Add per-statement quality scores and entity-level coverage scoring history

ALTER TABLE statements ADD COLUMN quality_score REAL;
ALTER TABLE statements ADD COLUMN quality_dimensions JSONB;
ALTER TABLE statements ADD COLUMN scored_at TIMESTAMPTZ;

CREATE TABLE entity_coverage_scores (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL,
  coverage_score REAL NOT NULL,
  category_scores JSONB NOT NULL,
  statement_count INTEGER NOT NULL,
  quality_avg REAL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ecs_entity_id ON entity_coverage_scores(entity_id);
CREATE INDEX idx_ecs_scored_at ON entity_coverage_scores(scored_at);
CREATE INDEX idx_statements_quality_score ON statements(quality_score);

-- Research Area Evaluations: LLM-scored dimensions for cross-area comparison
-- Part of the research areas comparison infrastructure.
-- Stores individual model evaluations and aggregated consensus scores.

-- Individual evaluations from LLM models (or humans)
CREATE TABLE IF NOT EXISTS research_area_evaluations (
  id BIGSERIAL PRIMARY KEY,
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,              -- 'maturity', 'neglectedness', 'tractability', etc.
  score DOUBLE PRECISION NOT NULL,      -- 1-10 scale
  confidence DOUBLE PRECISION,          -- 0-1; evaluator's self-reported confidence
  reasoning TEXT,                        -- brief justification for the score
  evaluator_type TEXT NOT NULL DEFAULT 'llm',  -- 'llm' | 'human'
  evaluator_id TEXT NOT NULL,           -- model ID ('claude-sonnet-4-6') or user identifier
  prompt_version TEXT,                  -- versioned prompt hash for reproducibility
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(research_area_id, dimension, evaluator_id, prompt_version)
);

CREATE INDEX idx_rae_area ON research_area_evaluations(research_area_id);
CREATE INDEX idx_rae_dimension ON research_area_evaluations(dimension);
CREATE INDEX idx_rae_evaluator ON research_area_evaluations(evaluator_id);

-- Aggregated consensus scores (computed from evaluations)
CREATE TABLE IF NOT EXISTS research_area_scores (
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  mean_score DOUBLE PRECISION NOT NULL,
  median_score DOUBLE PRECISION,
  std_dev DOUBLE PRECISION,
  min_score DOUBLE PRECISION,
  max_score DOUBLE PRECISION,
  num_evaluators INT NOT NULL DEFAULT 0,
  model_agreement DOUBLE PRECISION,     -- 0-1; 1 = perfect agreement across evaluators
  last_computed TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (research_area_id, dimension)
);

CREATE INDEX idx_ras_dimension ON research_area_scores(dimension);

-- Valid dimensions registry (so we can enumerate them in the UI)
CREATE TABLE IF NOT EXISTS evaluation_dimensions (
  id TEXT PRIMARY KEY,                  -- 'maturity', 'neglectedness', etc.
  label TEXT NOT NULL,                  -- 'Maturity', 'Neglectedness'
  description TEXT,                     -- tooltip / explanation
  category TEXT,                        -- 'prioritization', 'field-health', 'impact'
  scale_min DOUBLE PRECISION NOT NULL DEFAULT 1,
  scale_max DOUBLE PRECISION NOT NULL DEFAULT 10,
  higher_is_better BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial dimensions
INSERT INTO evaluation_dimensions (id, label, description, category, higher_is_better, sort_order) VALUES
  ('maturity', 'Maturity', 'How mature and well-established is this research field? (1=speculative, 10=well-established with textbooks)', 'field-health', true, 1),
  ('neglectedness', 'Neglectedness', 'How under-resourced is this area relative to its importance? (1=well-funded, 10=severely neglected)', 'prioritization', true, 2),
  ('tractability', 'Tractability', 'How likely are marginal resources to produce meaningful progress? (1=intractable, 10=low-hanging fruit)', 'prioritization', true, 3),
  ('importance', 'Importance', 'How important is progress here for reducing existential risk? (1=peripheral, 10=critical)', 'prioritization', true, 4),
  ('talent-gap', 'Talent Gap', 'How difficult is it to find qualified researchers for this area? (1=ample talent, 10=severe shortage)', 'field-health', true, 5),
  ('funding-gap', 'Funding Gap', 'How under-funded is this relative to opportunity? (1=well-funded, 10=large funding gap)', 'prioritization', true, 6),
  ('pace-of-progress', 'Pace of Progress', 'How fast is the field currently advancing? (1=stagnant, 10=rapid breakthroughs)', 'field-health', true, 7),
  ('consensus-level', 'Consensus Level', 'How much agreement exists on core questions and approaches? (1=deeply contested, 10=strong consensus)', 'field-health', true, 8),
  ('industry-adoption', 'Industry Adoption', 'How much has industry adopted findings from this area? (1=purely academic, 10=widely deployed)', 'impact', true, 9),
  ('counterfactual-value', 'Counterfactual Value', 'How much does marginal safety-community work here change outcomes vs. industry doing it anyway? (1=redundant, 10=uniquely valuable)', 'impact', true, 10)
ON CONFLICT (id) DO NOTHING;

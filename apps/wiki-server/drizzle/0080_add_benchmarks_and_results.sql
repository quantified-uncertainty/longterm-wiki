-- Benchmarks: definitions of AI evaluation benchmarks.
CREATE TABLE IF NOT EXISTS benchmarks (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT, -- coding | reasoning | math | knowledge | multimodal | safety | agentic | general
  description TEXT,
  website    TEXT,
  scoring_method TEXT, -- percentage | elo | accuracy | pass_at_1 | points
  higher_is_better BOOLEAN NOT NULL DEFAULT true,
  introduced_date TEXT, -- YYYY or YYYY-MM
  maintainer TEXT,
  source     TEXT,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_category ON benchmarks (category);

-- Benchmark results: individual model scores on benchmarks.
CREATE TABLE IF NOT EXISTS benchmark_results (
  id           VARCHAR(10) PRIMARY KEY,
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id),
  model_id     TEXT NOT NULL, -- entity slug of the ai-model
  score        DOUBLE PRECISION NOT NULL,
  unit         TEXT, -- % | elo | etc.
  date         TEXT, -- when the score was published
  source_url   TEXT,
  notes        TEXT,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_br_benchmark ON benchmark_results (benchmark_id);
CREATE INDEX IF NOT EXISTS idx_br_model ON benchmark_results (model_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_br_benchmark_model ON benchmark_results (benchmark_id, model_id);

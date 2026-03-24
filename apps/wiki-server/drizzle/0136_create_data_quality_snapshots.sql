CREATE TABLE data_quality_snapshots (
  id SERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Source-check verdicts
  verdicts_total INTEGER NOT NULL DEFAULT 0,
  verdicts_confirmed INTEGER NOT NULL DEFAULT 0,
  verdicts_contradicted INTEGER NOT NULL DEFAULT 0,
  verdicts_partial INTEGER NOT NULL DEFAULT 0,
  verdicts_unverifiable INTEGER NOT NULL DEFAULT 0,
  verdicts_outdated INTEGER NOT NULL DEFAULT 0,
  verdicts_needs_recheck INTEGER NOT NULL DEFAULT 0,
  -- Record coverage
  personnel_total INTEGER NOT NULL DEFAULT 0,
  personnel_with_source INTEGER NOT NULL DEFAULT 0,
  personnel_with_start_date INTEGER NOT NULL DEFAULT 0,
  grants_total INTEGER NOT NULL DEFAULT 0,
  grants_with_source INTEGER NOT NULL DEFAULT 0,
  investments_total INTEGER NOT NULL DEFAULT 0,
  investments_with_source INTEGER NOT NULL DEFAULT 0,
  funding_rounds_total INTEGER NOT NULL DEFAULT 0,
  -- Entity coverage
  entities_total INTEGER NOT NULL DEFAULT 0,
  entities_with_wiki_page INTEGER NOT NULL DEFAULT 0,
  -- FactBase
  factbase_entities INTEGER NOT NULL DEFAULT 0,
  factbase_facts INTEGER NOT NULL DEFAULT 0,
  -- Pages
  pages_total INTEGER NOT NULL DEFAULT 0,
  -- Extra JSON for future metrics without migration
  extra JSONB DEFAULT '{}'
);

CREATE INDEX idx_dqs_captured ON data_quality_snapshots (captured_at DESC);

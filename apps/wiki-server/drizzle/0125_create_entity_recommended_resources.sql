-- Entity Recommended Resources: books, papers, videos, blog posts recommended by/for any entity
CREATE TABLE IF NOT EXISTS entity_recommended_resources (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(stable_id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  url TEXT,
  authors TEXT,
  published_date TEXT,
  category TEXT,
  topics JSONB,
  importance INTEGER,
  is_seminal BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_err_entity_url
  ON entity_recommended_resources (entity_id, url)
  WHERE url IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_err_entity
  ON entity_recommended_resources (entity_id);

CREATE INDEX IF NOT EXISTS idx_err_resource
  ON entity_recommended_resources (resource_id);

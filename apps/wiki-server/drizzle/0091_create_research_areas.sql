-- Research areas: bodies of work with papers, organizations, and ongoing activity.
-- PG-first (like grants, personnel, benchmarks). Minimal YAML entity stubs for
-- EntityLink resolution only; all rich data lives here.

-- ── Core table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_areas (
  id TEXT PRIMARY KEY,                    -- slug: 'rlhf', 'mech-interp'
  numeric_id TEXT,                        -- 'E259' (nullable; links to entity_ids for wiki pages)
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | emerging | mature | declining | archived
  cluster TEXT,                           -- grouping: 'alignment-training', 'interpretability', etc.
  parent_area_id TEXT REFERENCES research_areas(id) ON DELETE SET NULL,
  first_proposed TEXT,                    -- '2017 (Christiano et al.)'
  first_proposed_year INT,               -- 2017 (for sorting)
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,  -- flexible facets: 'function:specification', 'stage:training'
  metadata JSONB NOT NULL DEFAULT '{}',   -- extensible: annual_investment, maturity_score, etc.
  source TEXT,                            -- primary reference URL
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ra_status ON research_areas(status);
CREATE INDEX IF NOT EXISTS idx_ra_cluster ON research_areas(cluster);
CREATE INDEX IF NOT EXISTS idx_ra_parent ON research_areas(parent_area_id);
CREATE INDEX IF NOT EXISTS idx_ra_tags ON research_areas USING GIN(tags jsonb_ops);

-- ── Organization links ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_area_organizations (
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,          -- entity stableId or slug
  role TEXT NOT NULL DEFAULT 'active',    -- pioneer | active | major | funder | emerging
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (research_area_id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_rao_org ON research_area_organizations(organization_id);

-- ── Key papers / resources ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_area_papers (
  id BIGSERIAL PRIMARY KEY,
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,  -- link to resources table if available
  title TEXT NOT NULL,
  url TEXT,
  authors TEXT,
  published_date TEXT,                    -- YYYY or YYYY-MM
  citation_count INT,
  is_seminal BOOLEAN NOT NULL DEFAULT false,  -- foundational paper for this area
  sort_order INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rap_area_url ON research_area_papers(research_area_id, url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rap_area ON research_area_papers(research_area_id);
CREATE INDEX IF NOT EXISTS idx_rap_resource ON research_area_papers(resource_id);

-- ── Risk links ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS research_area_risks (
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  risk_id TEXT NOT NULL,                  -- entity slug (e.g., 'reward-hacking')
  relevance TEXT NOT NULL DEFAULT 'addresses',  -- addresses | studies | exacerbates
  effectiveness TEXT,                     -- high | moderate | low | uncertain | null
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (research_area_id, risk_id)
);

CREATE INDEX IF NOT EXISTS idx_rar_risk ON research_area_risks(risk_id);

-- ── Grant links (many-to-many with existing grants table) ───────────────

CREATE TABLE IF NOT EXISTS grant_research_areas (
  grant_id VARCHAR(10) NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  research_area_id TEXT NOT NULL REFERENCES research_areas(id) ON DELETE CASCADE,
  confidence REAL,                        -- 0-1; how confident is the tag
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id, research_area_id)
);

CREATE INDEX IF NOT EXISTS idx_gra_area ON grant_research_areas(research_area_id);

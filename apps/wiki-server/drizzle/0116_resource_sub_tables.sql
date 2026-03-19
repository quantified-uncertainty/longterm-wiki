-- Migration 0116: Create type-specific sub-tables for resources
-- Three sub-tables: resource_papers, resource_forum_posts, resource_policy_docs
-- Each uses resource_id as PK with FK CASCADE to resources.

-- ── resource_papers ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_papers (
  resource_id text PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  arxiv_id text,
  doi text,
  semantic_scholar_id text,
  abstract text,
  citation_count integer,
  influential_citation_count integer,
  categories jsonb,           -- text[] e.g. ["cs.AI", "cs.CL"]
  methodology text,           -- empirical | theoretical | survey | benchmark | position
  year integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rp_arxiv_id ON resource_papers (arxiv_id);
CREATE INDEX IF NOT EXISTS idx_rp_doi ON resource_papers (doi);
CREATE INDEX IF NOT EXISTS idx_rp_semantic_scholar_id ON resource_papers (semantic_scholar_id);
CREATE INDEX IF NOT EXISTS idx_rp_year ON resource_papers (year);

-- ── resource_forum_posts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_forum_posts (
  resource_id text PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  forum text NOT NULL,          -- 'lesswrong' | 'alignmentforum' | 'eaforum'
  forum_post_id text,
  forum_slug text,
  karma integer,
  comment_count integer,
  author_username text,
  forum_tags jsonb,             -- text[]
  sequence_title text,
  curated boolean,
  cross_posted_from text,       -- resource_id of the original (if cross-posted)
  canonical_forum text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfp_forum ON resource_forum_posts (forum);
CREATE INDEX IF NOT EXISTS idx_rfp_forum_post_id ON resource_forum_posts (forum_post_id);
CREATE INDEX IF NOT EXISTS idx_rfp_cross_posted_from ON resource_forum_posts (cross_posted_from);

-- ── resource_policy_docs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_policy_docs (
  resource_id text PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  document_type text,           -- legislation | regulation | executive_order | guidance | report | treaty | standard
  jurisdiction_entity_id text,  -- FK to entities.stable_id (country/region entity)
  agency_entity_id text,        -- FK to entities.stable_id (org entity)
  policy_entity_id text,        -- FK to entities.stable_id (policy entity)
  effective_date text,          -- flexible date format
  document_status text,         -- proposed | enacted | expired | superseded
  reference_number text,        -- "SB-1047", "EO 14110"
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rpd_jurisdiction ON resource_policy_docs (jurisdiction_entity_id);
CREATE INDEX IF NOT EXISTS idx_rpd_agency ON resource_policy_docs (agency_entity_id);
CREATE INDEX IF NOT EXISTS idx_rpd_policy ON resource_policy_docs (policy_entity_id);
CREATE INDEX IF NOT EXISTS idx_rpd_document_type ON resource_policy_docs (document_type);

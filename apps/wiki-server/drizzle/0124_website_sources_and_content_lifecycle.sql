-- WS1: Add content_lifecycle to resources
-- WS2: Website source registry tables
-- Part of Discussion #2928: Websites as Data Feeds

-- ── Content Lifecycle ───────────────────────────────────────────────
-- Classifies how resource content behaves over time, guiding
-- verification scheduling and citation display.

ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "content_lifecycle" TEXT;
-- Values: 'immutable' | 'versioned' | 'evergreen' | 'ephemeral'

CREATE INDEX IF NOT EXISTS "idx_res_content_lifecycle"
  ON "resources" ("content_lifecycle");

-- ── Website Sources ─────────────────────────────────────────────────
-- Websites we actively track as structured data feeds.
-- Each source is a domain linked to an entity (usually an organization).

CREATE TABLE IF NOT EXISTS "website_sources" (
  "id" VARCHAR(10) PRIMARY KEY,
  "domain" TEXT NOT NULL,
  "entity_id" TEXT REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "entity_display_name" TEXT,
  "reliability" TEXT NOT NULL DEFAULT 'medium',
  "refresh_interval_days" INTEGER NOT NULL DEFAULT 30,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "notes" TEXT,
  "last_run_at" TIMESTAMP WITH TIME ZONE,
  "last_error" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_ws_domain"
  ON "website_sources" ("domain");
CREATE INDEX IF NOT EXISTS "idx_ws_entity"
  ON "website_sources" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_ws_enabled"
  ON "website_sources" ("enabled");

-- ── Website Source Pages ────────────────────────────────────────────
-- Individual pages within a tracked website. Each page has its own
-- fetch schedule, extraction targets, and snapshot tracking.

CREATE TABLE IF NOT EXISTS "website_source_pages" (
  "id" VARCHAR(10) PRIMARY KEY,
  "source_id" VARCHAR(10) NOT NULL REFERENCES "website_sources"("id") ON DELETE CASCADE,
  "path" TEXT NOT NULL,
  "page_role" TEXT,
  "extract_targets" JSONB,
  "refresh_interval_days" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "last_fetched_at" TIMESTAMP WITH TIME ZONE,
  "last_content_hash" TEXT,
  "last_snapshot_id" VARCHAR(10),
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_wsp_source_path"
  ON "website_source_pages" ("source_id", "path");
CREATE INDEX IF NOT EXISTS "idx_wsp_role"
  ON "website_source_pages" ("page_role");
CREATE INDEX IF NOT EXISTS "idx_wsp_enabled"
  ON "website_source_pages" ("enabled");

-- Data-first architecture: new tables for entity events, assessments,
-- publications, and compensation fields on personnel.
-- Part of Discussion #2905: Wiki Pages as Tabs + Structured Data Extraction.

-- ── Personnel: add compensation fields ──────────────────────────────

ALTER TABLE "personnel" ADD COLUMN IF NOT EXISTS "compensation" NUMERIC;
ALTER TABLE "personnel" ADD COLUMN IF NOT EXISTS "compensation_year" TEXT;
ALTER TABLE "personnel" ADD COLUMN IF NOT EXISTS "compensation_source" TEXT;

-- ── Entity Events ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_events" (
  "id" VARCHAR(10) PRIMARY KEY,
  "entity_id" TEXT NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "entity_display_name" TEXT,
  "date" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "event_type" TEXT NOT NULL,
  "significance" TEXT,
  "source" TEXT,
  "notes" TEXT,
  "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_ee_entity" ON "entity_events" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_ee_date" ON "entity_events" ("date");
CREATE INDEX IF NOT EXISTS "idx_ee_type" ON "entity_events" ("event_type");
CREATE INDEX IF NOT EXISTS "idx_ee_significance" ON "entity_events" ("significance");

-- ── Entity Assessments ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "entity_assessments" (
  "id" VARCHAR(10) PRIMARY KEY,
  "entity_id" TEXT NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "dimension" TEXT NOT NULL,
  "rating" TEXT NOT NULL,
  "evidence" TEXT,
  "assessor" TEXT NOT NULL DEFAULT 'editorial',
  "assessed_at" TEXT,
  "source" TEXT,
  "notes" TEXT,
  "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_ea_entity" ON "entity_assessments" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_ea_dimension" ON "entity_assessments" ("dimension");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_entity_assessment_natural_key"
  ON "entity_assessments" ("entity_id", "dimension", "assessor");

-- ── Publications ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "publications" (
  "id" VARCHAR(10) PRIMARY KEY,
  "entity_id" TEXT NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "entity_display_name" TEXT,
  "resource_id" TEXT REFERENCES "resources"("id") ON DELETE SET NULL,
  "title" TEXT NOT NULL,
  "authors" TEXT,
  "url" TEXT,
  "venue" TEXT,
  "published_date" TEXT,
  "publication_type" TEXT NOT NULL DEFAULT 'paper',
  "citation_count" INTEGER,
  "is_flagship" BOOLEAN NOT NULL DEFAULT FALSE,
  "abstract" TEXT,
  "source" TEXT,
  "notes" TEXT,
  "synced_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_pub_entity" ON "publications" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_pub_resource" ON "publications" ("resource_id");
CREATE INDEX IF NOT EXISTS "idx_pub_type" ON "publications" ("publication_type");
CREATE INDEX IF NOT EXISTS "idx_pub_date" ON "publications" ("published_date");
CREATE INDEX IF NOT EXISTS "idx_pub_flagship" ON "publications" ("is_flagship");

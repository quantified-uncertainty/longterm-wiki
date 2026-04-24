-- QUA-688 Phase 1: External scorecard mirror.
--
-- Two tables:
--   scorecard_snapshots — one row per (source, wave) e.g. "FLI Summer 2025".
--   scorecard_grades    — one row per (snapshot, org, dimension); cells.
--
-- Authoritative source is data/scorecards/snapshots/*.yaml. PG mirrors that
-- via the standard sync-factory POST /sync flow.
--
-- ## Invariants
--   * Exactly one snapshot per scorecard_source has is_latest=true (partial
--     unique index below + sync-factory upsert reset).
--   * (snapshot_id, entity_id, dimension_slug) is unique in scorecard_grades.
--   * entity_id references entities.stable_id (FK) — guarantees rendering
--     can look up canonical names.
--
-- No CHECK constraint on scorecard_source yet — sources are added one wave
-- at a time and the value list is a five-element closed set today, but per
-- .claude/rules/database-migrations.md we'd need a prod enumeration before
-- locking it. Defer to a follow-up after Phase 1 prod data exists.

CREATE TABLE IF NOT EXISTS "scorecard_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "scorecard_source" text NOT NULL,
  "wave_label" text,
  "published_at" date NOT NULL,
  "captured_at" timestamp with time zone NOT NULL DEFAULT now(),
  "source_url" text NOT NULL,
  "methodology_url" text,
  "license" text,
  "org_count" integer NOT NULL DEFAULT 0,
  "dimension_count" integer NOT NULL DEFAULT 0,
  "notes" text,
  "is_latest" boolean NOT NULL DEFAULT false,
  "source_active" boolean NOT NULL DEFAULT true,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_scorecard_snapshots_source"
  ON "scorecard_snapshots" ("scorecard_source");
CREATE INDEX IF NOT EXISTS "idx_scorecard_snapshots_published"
  ON "scorecard_snapshots" ("published_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scorecard_snapshots_latest_per_source"
  ON "scorecard_snapshots" ("scorecard_source")
  WHERE "is_latest" = true;

CREATE TABLE IF NOT EXISTS "scorecard_grades" (
  "id" text PRIMARY KEY NOT NULL,
  "snapshot_id" text NOT NULL REFERENCES "scorecard_snapshots"("id") ON DELETE CASCADE,
  "entity_id" text NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "entity_display_name" text NOT NULL,
  "dimension_slug" text NOT NULL,
  "dimension_label" text NOT NULL,
  "dimension_weight" numeric,
  "dimension_parent_slug" text,
  "score_numeric" numeric,
  "score_letter" text,
  "score_raw" text NOT NULL,
  "notes" text,
  "source_url" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_scorecard_grades_snapshot"
  ON "scorecard_grades" ("snapshot_id");
CREATE INDEX IF NOT EXISTS "idx_scorecard_grades_entity"
  ON "scorecard_grades" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_scorecard_grades_dimension"
  ON "scorecard_grades" ("dimension_slug");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_scorecard_grades_natural_key"
  ON "scorecard_grades" ("snapshot_id", "entity_id", "dimension_slug");

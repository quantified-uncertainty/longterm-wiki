-- Phase 1: Statements System (#1540)
-- Creates properties, statements, and statement_citations tables
-- alongside existing claims/facts tables (no in-place conversion).

-- Properties — controlled vocabulary for structured data
CREATE TABLE IF NOT EXISTS "properties" (
  "id" text PRIMARY KEY NOT NULL,
  "label" text NOT NULL,
  "category" text NOT NULL,
  "description" text,
  "entity_types" text[] NOT NULL DEFAULT '{}'::text[],
  "value_type" text NOT NULL,
  "default_unit" text,
  "staleness_cadence" text,
  "unit_format_id" text,
  "range_entity_types" text[],
  "inverse_property_id" text,
  "is_symmetric" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_prop_category" ON "properties" USING btree ("category");
CREATE INDEX IF NOT EXISTS "idx_prop_value_type" ON "properties" USING btree ("value_type");

-- Statements — all facts, structured + attributed varieties
CREATE TABLE IF NOT EXISTS "statements" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "variety" text NOT NULL,
  "statement_text" text,
  "subject_entity_id" text NOT NULL REFERENCES "entities"("id") ON DELETE CASCADE,
  "property_id" text REFERENCES "properties"("id") ON DELETE SET NULL,
  "value_numeric" double precision,
  "value_unit" text,
  "value_text" text,
  "value_entity_id" text REFERENCES "entities"("id") ON DELETE SET NULL,
  "value_date" date,
  "value_series" jsonb,
  "qualifier_key" text,
  "valid_start" text,
  "valid_end" text,
  "temporal_granularity" text,
  "attributed_to" text REFERENCES "entities"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'active',
  "archive_reason" text,
  "source_fact_key" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_stmt_subject" ON "statements" USING btree ("subject_entity_id");
CREATE INDEX IF NOT EXISTS "idx_stmt_property" ON "statements" USING btree ("property_id");
CREATE INDEX IF NOT EXISTS "idx_stmt_variety" ON "statements" USING btree ("variety");
CREATE INDEX IF NOT EXISTS "idx_stmt_status" ON "statements" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_stmt_valid_start" ON "statements" USING btree ("valid_start");
CREATE INDEX IF NOT EXISTS "idx_stmt_subject_property" ON "statements" USING btree ("subject_entity_id", "property_id");
CREATE INDEX IF NOT EXISTS "idx_stmt_source_fact_key" ON "statements" USING btree ("source_fact_key");

-- Statement citations — links statements to source resources
CREATE TABLE IF NOT EXISTS "statement_citations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "statement_id" bigint NOT NULL REFERENCES "statements"("id") ON DELETE CASCADE,
  "resource_id" text REFERENCES "resources"("id") ON DELETE SET NULL,
  "url" text,
  "source_quote" text,
  "location_note" text,
  "is_primary" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_sc_statement_id" ON "statement_citations" USING btree ("statement_id");
CREATE INDEX IF NOT EXISTS "idx_sc_resource_id" ON "statement_citations" USING btree ("resource_id");
CREATE INDEX IF NOT EXISTS "idx_sc_is_primary" ON "statement_citations" USING btree ("is_primary");

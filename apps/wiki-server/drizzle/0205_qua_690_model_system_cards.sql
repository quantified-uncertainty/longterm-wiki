-- QUA-690 Phase 3: model_system_cards table.
--
-- Structured extraction of fields published in flagship AI model / system
-- cards, so the top ~60 models are comparable on a uniform set of
-- dimensions. One row per published card; multiple cards per model are
-- allowed (republished cards, hub updates). `source_hash` captures silent
-- edits — a new hash for the same version = a new row documenting drift.
--
-- Schema in apps/wiki-server/src/schema.ts::modelSystemCards.

CREATE TABLE IF NOT EXISTS "model_system_cards" (
  "id" text PRIMARY KEY,
  "ai_model_id" text NOT NULL,
  "ai_model_display_name" text,
  "version" text,
  "release_date" date,
  "deprecation_date" date,
  "training_cutoff" date,
  "training_compute_flops" numeric,
  "training_gpu_hours" numeric,
  "training_hardware" text,
  "parameters_total" bigint,
  "parameters_active" bigint,
  "architecture" text,
  "modalities_in" text[],
  "modalities_out" text[],
  "context_window_tokens" integer,
  "output_window_tokens" integer,
  "languages_supported" text[],
  "safety_framework" text,
  "safety_tier" text,
  "safety_tier_domains" jsonb,
  "safeguards_summary" text,
  "classifier_details" jsonb,
  "fine_tuning_policy" text,
  "deployment_channels" text[],
  "eval_scores_cited" jsonb,
  "third_party_evals" jsonb,
  "red_team_summary" text,
  "incident_disclosures" text,
  "source_url" text NOT NULL,
  "source_format" text,
  "source_hash" text,
  "wayback_snapshot_url" text,
  "system_prompt_url" text,
  "usage_policy_url" text,
  "extracted_at" timestamptz,
  "extractor_version" text,
  "extraction_model" text,
  "extraction_confidence" jsonb,
  "notes" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_msc_ai_model"
  ON "model_system_cards" ("ai_model_id");

CREATE INDEX IF NOT EXISTS "idx_msc_safety_framework"
  ON "model_system_cards" ("safety_framework");

CREATE INDEX IF NOT EXISTS "idx_msc_safety_tier"
  ON "model_system_cards" ("safety_tier");

CREATE INDEX IF NOT EXISTS "idx_msc_release_date"
  ON "model_system_cards" ("release_date" DESC);

-- Natural key: (ai_model_id, version, release_date). COALESCE'd so NULL
-- version or release_date doesn't fall through the uniqueness check.
-- We avoid `::text` on the date column because date->text conversion
-- depends on `DateStyle` and is therefore not IMMUTABLE; Postgres rejects
-- it inside an index expression. Sentinel '0001-01-01' is older than any
-- real release date, so a NULL release_date collates with itself.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_msc_natural_key"
  ON "model_system_cards" (
    "ai_model_id",
    COALESCE("version", ''),
    COALESCE("release_date", '0001-01-01'::date)
  );

-- source_format allowlist. Added NOT VALID so this DDL is lock-cheap
-- (the table is new + empty, but we keep the pattern consistent with
-- docs/agent-rules/database-migrations.md for future ALTERs).
ALTER TABLE "model_system_cards"
  ADD CONSTRAINT "chk_msc_source_format"
  CHECK ("source_format" IS NULL OR "source_format" IN (
    'pdf', 'html', 'markdown', 'arxiv-paper', 'missing'
  )) NOT VALID;

ALTER TABLE "model_system_cards" VALIDATE CONSTRAINT "chk_msc_source_format";

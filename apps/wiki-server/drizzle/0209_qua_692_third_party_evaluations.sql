-- QUA-692 Phase 5: third_party_evaluations + third_party_evaluation_models.
--
-- Index of published pre-deployment evaluations and red-team reports from
-- external evaluators (UK AISI, US AISI / CAISI, METR, Apollo Research).
-- The report is the natural key (one report can cover N models); the
-- many-to-many fan-out lives in `third_party_evaluation_models`.
--
-- Schema in apps/wiki-server/src/schema.ts::thirdPartyEvaluations.
--
-- Greenfield tables. CHECK on `risk_domain` and `source_format` is added
-- inline (no NOT VALID dance needed) since 0 legacy rows exist; the pattern
-- in `docs/agent-rules/database-migrations.md` only requires NOT VALID for
-- ALTERs on tables with existing data.

CREATE TABLE IF NOT EXISTS "third_party_evaluations" (
  "id" text PRIMARY KEY,
  "evaluator_org_id" text NOT NULL,
  "evaluator_org_display_name" text,
  "report_url" text NOT NULL UNIQUE,
  "report_pdf_url" text,
  "title" text NOT NULL,
  "published_date" date,
  "risk_domain" text[] NOT NULL,
  "pre_deployment" boolean,
  "findings_summary" text,
  "capability_levels_assessed" jsonb,
  "methodology_url" text,
  "source_format" text,
  "source_hash" text,
  "wayback_snapshot_url" text,
  "source_system" text NOT NULL,
  "extracted_at" timestamptz,
  "extractor_version" text,
  "extraction_model" text,
  "extraction_confidence" jsonb,
  "notes" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_tpe_evaluator"
  ON "third_party_evaluations" ("evaluator_org_id");

CREATE INDEX IF NOT EXISTS "idx_tpe_published_date"
  ON "third_party_evaluations" ("published_date" DESC);

CREATE INDEX IF NOT EXISTS "idx_tpe_pre_deployment"
  ON "third_party_evaluations" ("pre_deployment");

-- GIN supports array-overlap queries (`risk_domain && ARRAY['cyber']`)
-- which the dashboard filters use.
CREATE INDEX IF NOT EXISTS "idx_tpe_risk_domain_gin"
  ON "third_party_evaluations" USING GIN ("risk_domain");

-- Controlled vocab for risk_domain. Values must align with
-- `crux/validate/validate-third-party-eval-refs.ts`. Adding a new domain
-- requires a follow-up migration that ALTERs the constraint via
-- NOT VALID + VALIDATE CONSTRAINT.
ALTER TABLE "third_party_evaluations"
  ADD CONSTRAINT "chk_tpe_risk_domain"
  CHECK (
    "risk_domain" <@ ARRAY[
      'cbrn',
      'biological',
      'chemical',
      'radiological',
      'nuclear',
      'cyber',
      'autonomy',
      'agent-security',
      'persuasion',
      'scheming',
      'deception',
      'jailbreak',
      'safeguard-efficacy',
      'evaluation-awareness',
      'misuse',
      'misc'
    ]::text[]
  );

ALTER TABLE "third_party_evaluations"
  ADD CONSTRAINT "chk_tpe_source_format"
  CHECK (
    "source_format" IS NULL OR "source_format" IN (
      'pdf', 'html', 'markdown', 'arxiv-paper', 'missing'
    )
  );

ALTER TABLE "third_party_evaluations"
  ADD CONSTRAINT "chk_tpe_source_system"
  CHECK (
    "source_system" IN ('sitemap', 'rss', 'html-scrape', 'manual')
  );

-- Many-to-many: report ↔ model fan-out.
CREATE TABLE IF NOT EXISTS "third_party_evaluation_models" (
  "evaluation_id" text NOT NULL,
  "ai_model_id" text NOT NULL,
  "ai_model_display_name" text,
  "raw_name_in_report" text,
  "match_confidence" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("evaluation_id", "ai_model_id")
);

CREATE INDEX IF NOT EXISTS "idx_tpem_ai_model"
  ON "third_party_evaluation_models" ("ai_model_id");

ALTER TABLE "third_party_evaluation_models"
  ADD CONSTRAINT "chk_tpem_match_confidence"
  CHECK ("match_confidence" IN ('exact', 'fuzzy', 'manual'));

-- ON DELETE CASCADE: if a report row is removed (replaced URL, dedup), the
-- fan-out rows go with it. The link to the model entity is intentionally
-- NOT a hard FK — entities lives in a different mirror and stableIds are
-- resolved by the sync handler at write time.
ALTER TABLE "third_party_evaluation_models"
  ADD CONSTRAINT "fk_tpem_evaluation"
  FOREIGN KEY ("evaluation_id")
  REFERENCES "third_party_evaluations"("id")
  ON DELETE CASCADE;

-- QUA-691 Phase 4: frontier safety framework tracker.
--
-- Six tables tracking published frontier-safety frameworks (Anthropic RSP,
-- OpenAI Preparedness, DeepMind FSF, ...) with per-version archival,
-- extracted capability thresholds, and inter-version diffs surfaced for
-- weakening detection.
--
-- Schema in apps/wiki-server/src/schema.ts::{safetyFrameworks,
-- safetyFrameworkVersions, frameworkCapabilityThresholds, frameworkDiffs,
-- frameworkDiffItems, frameworkIngestLog}.
--
-- CHECK constraint allowlists use `NOT VALID` + `VALIDATE CONSTRAINT` per
-- .claude/rules/database-migrations.md. All tables are new + empty, but
-- keeping the pattern so future ALTERs remain lock-cheap.

-- ---------------------------------------------------------------------------
-- safety_frameworks — one row per lab's framework (~12 rows total)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "safety_frameworks" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "org_display_name" text,
  "name" text NOT NULL,
  "short_name" text,
  "latest_version_id" text,
  "first_published_date" date,
  "current_status" text,
  "framework_family" text,
  "notes" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_sf_org" ON "safety_frameworks" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_sf_status" ON "safety_frameworks" ("current_status");
CREATE INDEX IF NOT EXISTS "idx_sf_family" ON "safety_frameworks" ("framework_family");

ALTER TABLE "safety_frameworks"
  ADD CONSTRAINT "chk_sf_current_status"
  CHECK ("current_status" IS NULL OR "current_status" IN (
    'active', 'archived', 'superseded', 'draft'
  )) NOT VALID;
ALTER TABLE "safety_frameworks" VALIDATE CONSTRAINT "chk_sf_current_status";

-- ---------------------------------------------------------------------------
-- safety_framework_versions — one row per published version
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "safety_framework_versions" (
  "id" text PRIMARY KEY,
  "framework_id" text NOT NULL,
  "version_label" text NOT NULL,
  "version_sort_order" integer NOT NULL,
  "published_date" date,
  "discovered_date" date NOT NULL,
  "source_url" text NOT NULL,
  "source_url_canonical" text,
  "wayback_snapshot_url" text,
  "pdf_archive_url" text,
  "content_hash" text NOT NULL,
  "content_length_chars" integer,
  "summary" text,
  "is_draft" boolean NOT NULL DEFAULT false,
  "superseded_by_version_id" text,
  "ingest_status" text NOT NULL DEFAULT 'pending_review',
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_sfv_framework"
  ON "safety_framework_versions" ("framework_id");
CREATE INDEX IF NOT EXISTS "idx_sfv_published_date"
  ON "safety_framework_versions" ("published_date" DESC);
CREATE INDEX IF NOT EXISTS "idx_sfv_ingest_status"
  ON "safety_framework_versions" ("ingest_status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sfv_content_hash"
  ON "safety_framework_versions" ("framework_id", "content_hash");

ALTER TABLE "safety_framework_versions"
  ADD CONSTRAINT "chk_sfv_ingest_status"
  CHECK ("ingest_status" IN ('pending_review', 'published', 'rejected')) NOT VALID;
ALTER TABLE "safety_framework_versions" VALIDATE CONSTRAINT "chk_sfv_ingest_status";

-- ---------------------------------------------------------------------------
-- framework_capability_thresholds — per-version extracted thresholds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "framework_capability_thresholds" (
  "id" text PRIMARY KEY,
  "version_id" text NOT NULL,
  "risk_domain_canonical" text NOT NULL,
  "risk_domain_label" text NOT NULL,
  "tier_label" text NOT NULL,
  "tier_sort_order" integer NOT NULL,
  "trigger_description" text NOT NULL,
  "source_quote" text NOT NULL,
  "source_page_hint" text,
  "required_mitigations" jsonb,
  "associated_evals" jsonb,
  "commitment_language" text,
  "extracted_by_model" text,
  "extraction_confidence" numeric,
  "human_reviewed" boolean NOT NULL DEFAULT false,
  "human_review_notes" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_fct_version"
  ON "framework_capability_thresholds" ("version_id");
CREATE INDEX IF NOT EXISTS "idx_fct_canonical_domain"
  ON "framework_capability_thresholds" ("risk_domain_canonical");
CREATE INDEX IF NOT EXISTS "idx_fct_tier_sort"
  ON "framework_capability_thresholds" ("tier_sort_order");
CREATE INDEX IF NOT EXISTS "idx_fct_reviewed"
  ON "framework_capability_thresholds" ("human_reviewed");

ALTER TABLE "framework_capability_thresholds"
  ADD CONSTRAINT "chk_fct_risk_domain_canonical"
  CHECK ("risk_domain_canonical" IN (
    'cbrn', 'bio', 'chem', 'nuclear', 'radiological',
    'cyber', 'autonomy_replication', 'ai_rd',
    'scheming', 'persuasion', 'loss_of_control', 'other'
  )) NOT VALID;
ALTER TABLE "framework_capability_thresholds"
  VALIDATE CONSTRAINT "chk_fct_risk_domain_canonical";

ALTER TABLE "framework_capability_thresholds"
  ADD CONSTRAINT "chk_fct_commitment_language"
  CHECK ("commitment_language" IS NULL OR "commitment_language" IN (
    'committed', 'aspirational', 'conditional', 'informational'
  )) NOT VALID;
ALTER TABLE "framework_capability_thresholds"
  VALIDATE CONSTRAINT "chk_fct_commitment_language";

ALTER TABLE "framework_capability_thresholds"
  ADD CONSTRAINT "chk_fct_tier_sort"
  CHECK ("tier_sort_order" BETWEEN 1 AND 5) NOT VALID;
ALTER TABLE "framework_capability_thresholds"
  VALIDATE CONSTRAINT "chk_fct_tier_sort";

-- ---------------------------------------------------------------------------
-- framework_diffs — version-pair diff aggregate
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "framework_diffs" (
  "id" text PRIMARY KEY,
  "from_version_id" text NOT NULL,
  "to_version_id" text NOT NULL,
  "change_summary" text NOT NULL,
  "weakening_flagged" boolean NOT NULL DEFAULT false,
  "strengthening_flagged" boolean NOT NULL DEFAULT false,
  "neutral_changes_count" integer,
  "diff_details" jsonb,
  "overall_direction" text,
  "human_reviewed" boolean NOT NULL DEFAULT false,
  "review_verdict" text NOT NULL DEFAULT 'unreviewed',
  "review_notes" text,
  "classified_by_model" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_fd_from" ON "framework_diffs" ("from_version_id");
CREATE INDEX IF NOT EXISTS "idx_fd_to" ON "framework_diffs" ("to_version_id");
CREATE INDEX IF NOT EXISTS "idx_fd_weakening" ON "framework_diffs" ("weakening_flagged");
CREATE INDEX IF NOT EXISTS "idx_fd_direction" ON "framework_diffs" ("overall_direction");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fd_version_pair"
  ON "framework_diffs" ("from_version_id", "to_version_id");

ALTER TABLE "framework_diffs"
  ADD CONSTRAINT "chk_fd_overall_direction"
  CHECK ("overall_direction" IS NULL OR "overall_direction" IN (
    'weaker', 'stronger', 'mixed', 'neutral', 'rewrite'
  )) NOT VALID;
ALTER TABLE "framework_diffs" VALIDATE CONSTRAINT "chk_fd_overall_direction";

ALTER TABLE "framework_diffs"
  ADD CONSTRAINT "chk_fd_review_verdict"
  CHECK ("review_verdict" IN (
    'confirmed_weakening', 'confirmed_strengthening',
    'false_positive', 'nuanced', 'unreviewed'
  )) NOT VALID;
ALTER TABLE "framework_diffs" VALIDATE CONSTRAINT "chk_fd_review_verdict";

-- ---------------------------------------------------------------------------
-- framework_diff_items — per-change atomic rows
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "framework_diff_items" (
  "id" text PRIMARY KEY,
  "diff_id" text NOT NULL,
  "change_type" text NOT NULL,
  "risk_domain_canonical" text,
  "before_snapshot" jsonb,
  "after_snapshot" jsonb,
  "severity" integer,
  "classifier_tag" text,
  "rationale" text,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_fdi_diff" ON "framework_diff_items" ("diff_id");
CREATE INDEX IF NOT EXISTS "idx_fdi_change_type" ON "framework_diff_items" ("change_type");

ALTER TABLE "framework_diff_items"
  ADD CONSTRAINT "chk_fdi_change_type"
  CHECK ("change_type" IN (
    'threshold_added', 'threshold_removed', 'mitigation_softened',
    'mitigation_strengthened', 'commitment_weakened', 'commitment_strengthened',
    'scope_narrowed', 'scope_broadened', 'eval_changed', 'clarification', 'other'
  )) NOT VALID;
ALTER TABLE "framework_diff_items" VALIDATE CONSTRAINT "chk_fdi_change_type";

ALTER TABLE "framework_diff_items"
  ADD CONSTRAINT "chk_fdi_classifier_tag"
  CHECK ("classifier_tag" IS NULL OR "classifier_tag" IN (
    'weaker', 'stronger', 'rewrite_equivalent',
    'scope_narrowed', 'scope_broadened', 'clarification'
  )) NOT VALID;
ALTER TABLE "framework_diff_items" VALIDATE CONSTRAINT "chk_fdi_classifier_tag";

ALTER TABLE "framework_diff_items"
  ADD CONSTRAINT "chk_fdi_severity"
  CHECK ("severity" IS NULL OR "severity" BETWEEN 1 AND 3) NOT VALID;
ALTER TABLE "framework_diff_items" VALIDATE CONSTRAINT "chk_fdi_severity";

-- ---------------------------------------------------------------------------
-- framework_ingest_log — audit trail of fetches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "framework_ingest_log" (
  "id" text PRIMARY KEY,
  "framework_id" text NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT NOW(),
  "source_url" text NOT NULL,
  "content_hash" text,
  "status" text NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_fil_framework"
  ON "framework_ingest_log" ("framework_id");
CREATE INDEX IF NOT EXISTS "idx_fil_status"
  ON "framework_ingest_log" ("status");
CREATE INDEX IF NOT EXISTS "idx_fil_fetched_at"
  ON "framework_ingest_log" ("fetched_at" DESC);

ALTER TABLE "framework_ingest_log"
  ADD CONSTRAINT "chk_fil_status"
  CHECK ("status" IN (
    'new_version', 'unchanged', 'silent_update_detected', 'fetch_failed'
  )) NOT VALID;
ALTER TABLE "framework_ingest_log" VALIDATE CONSTRAINT "chk_fil_status";

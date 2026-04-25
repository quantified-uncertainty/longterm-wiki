-- QUA-689 Phase 2 (foundation): Safety-benchmark ingestion schema extensions.
--
-- Three changes to unblock the parallel ingester work in follow-up PRs:
--
--   1. benchmarks: extend the category vocabulary via a CHECK constraint and
--      add sub_category. Prod enumeration confirmed today (2026-04-25):
--        SELECT category, count(*) FROM benchmarks GROUP BY category
--          → multimodal:4, safety:1, knowledge:3, coding:8, math:7,
--            general:6, agentic:8, reasoning:9 (8 distinct, 46 rows total).
--      The CHECK list below is a strict superset of the live values, plus
--      the 4 new safety-focused buckets (dangerous-capability, robustness,
--      honesty, adversarial) Phase 2 ingesters need. NOT VALID + VALIDATE
--      pattern per .claude/rules/database-migrations.md.
--
--   2. benchmark_results: add provenance columns (tested_by,
--      tested_by_org_id, evaluation_date, methodology_notes), and widen the
--      unique index from (benchmark_id, model_id) to a composite that lets
--      the same model have multiple results per benchmark distinguished by
--      evaluator (self-report vs leaderboard vs AISI etc.) and evaluation
--      date. The old index is dropped and replaced — no data loss because
--      the new index is strictly wider.
--
--      tested_by uses a CHECK allowlist enumerated from the implementation
--      plan: self-report, leaderboard, aisi-uk, aisi-us, metr, apollo,
--      third-party-paper, epoch-ai, unknown. The current 357 prod rows have
--      no tested_by column today (it's new), so backfilling defaults to
--      'unknown' is safe — there are no preexisting non-allowlisted values.
--
--   3. model_aliases: new table mapping lowercased alias strings (as they
--      appear on external leaderboards) to entities.stable_id. Replaces the
--      hardcoded 40-entry maps duplicated across the existing sync code.
--      Seeded from data/entities/ai-models.yaml `aliases:` arrays in a
--      follow-up; this migration only creates the table.
--
--   4. benchmark_results_pending: new quarantine table for ingester rows
--      whose source model name didn't resolve to any entity. Reviewed via
--      the /internal/benchmark-quarantine dashboard (follow-up PR).
--
-- Schema lives in apps/wiki-server/src/schema.ts. Sync handlers for the two
-- new tables live in apps/wiki-server/src/routes/tablebase/.

-- =====================================================================
-- 1. benchmarks: category CHECK + sub_category column
-- =====================================================================

ALTER TABLE "benchmarks"
  ADD COLUMN IF NOT EXISTS "sub_category" text;

-- The CHECK list is a strict superset of the 8 live category values
-- (multimodal, safety, knowledge, coding, math, general, agentic, reasoning)
-- plus 4 new safety-focused buckets the Phase 2 ingesters introduce
-- (dangerous-capability, robustness, honesty, adversarial). Allow NULL for
-- existing rows that may not have a category set yet.
ALTER TABLE "benchmarks"
  ADD CONSTRAINT "chk_benchmarks_category"
  CHECK ("category" IS NULL OR "category" IN (
    'general',
    'reasoning',
    'math',
    'coding',
    'knowledge',
    'multimodal',
    'agentic',
    'safety',
    'dangerous-capability',
    'robustness',
    'honesty',
    'adversarial'
  )) NOT VALID;

ALTER TABLE "benchmarks" VALIDATE CONSTRAINT "chk_benchmarks_category";

-- =====================================================================
-- 2. benchmark_results: provenance columns + widen unique index
-- =====================================================================
--
-- IMPORTANT: migration 0212 (QUA-702) already added a nullable
-- `tested_by text` column with a CHECK constraint of
-- `(tested_by IS NULL OR tested_by IN ('self-report', 'third-party'))` and
-- an index `idx_br_tested_by`. This migration extends that to a wider
-- allowlist + NOT NULL column, adds three more columns, and widens the
-- unique index. Steps must be ordered to handle the 0212 state without
-- failing on duplicate constraint / column / index names.
--
-- Live enumeration before writing this migration (per
-- .claude/rules/database-migrations.md § "Adding CHECK constraints"): the
-- 0212 allowlist was 'self-report' / 'third-party' / NULL, so the only
-- legacy values that could exist on prod today are exactly those three.
-- All three are preserved in the new constraint below ('third-party' kept
-- explicitly so QUA-702-tagged rows survive the constraint swap).

-- 2a. Drop 0212's narrow CHECK constraint to make room for the wider one.
ALTER TABLE "benchmark_results"
  DROP CONSTRAINT IF EXISTS "chk_br_tested_by";

-- 2b. Backfill any NULL legacy rows to 'unknown' so we can tighten the
-- column to NOT NULL DEFAULT 'unknown' below.
UPDATE "benchmark_results" SET "tested_by" = 'unknown' WHERE "tested_by" IS NULL;

-- 2c. Tighten the existing column from 0212. ADD COLUMN IF NOT EXISTS is
-- not enough here because 0212 created the column without NOT NULL or a
-- default — IF NOT EXISTS would silently leave it nullable.
ALTER TABLE "benchmark_results"
  ALTER COLUMN "tested_by" SET DEFAULT 'unknown',
  ALTER COLUMN "tested_by" SET NOT NULL;

-- 2d. Add the three new provenance columns (genuinely new — not in 0212).
ALTER TABLE "benchmark_results"
  ADD COLUMN IF NOT EXISTS "tested_by_org_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "evaluation_date" text,
  ADD COLUMN IF NOT EXISTS "methodology_notes" text;

CREATE INDEX IF NOT EXISTS "idx_br_tested_by_org_id"
  ON "benchmark_results" ("tested_by_org_id");

-- 2e. Re-apply the wider CHECK. 'third-party' is kept for backward compat
-- with rows tagged by the QUA-702 model_system_cards postUpsert hook
-- before this migration ran.
ALTER TABLE "benchmark_results"
  ADD CONSTRAINT "chk_br_tested_by"
  CHECK ("tested_by" IN (
    'self-report',
    'leaderboard',
    'aisi-uk',
    'aisi-us',
    'metr',
    'apollo',
    'third-party',
    'third-party-paper',
    'epoch-ai',
    'unknown'
  )) NOT VALID;

ALTER TABLE "benchmark_results" VALIDATE CONSTRAINT "chk_br_tested_by";

-- 2f. Drop the narrow (benchmark_id, model_id) unique index and replace
-- with a 4-column composite. With the same (benchmark_id, model_id),
-- different (tested_by, evaluation_date) combinations are now distinct
-- rows. This supports e.g. Anthropic self-report MMLU vs HELM-leaderboard
-- MMLU vs AISI-UK MMLU for the same Claude model. COALESCE on
-- evaluation_date so NULL doesn't fall through the uniqueness check.
DROP INDEX IF EXISTS "idx_br_benchmark_model";

CREATE UNIQUE INDEX IF NOT EXISTS "idx_br_benchmark_model_testedby_date"
  ON "benchmark_results" (
    "benchmark_id",
    "model_id",
    "tested_by",
    COALESCE("evaluation_date", '')
  );

-- 2g. idx_br_tested_by already exists from 0212 (IF NOT EXISTS protects
-- against re-creation). Kept for explicitness so this file documents the
-- full final shape of benchmark_results indexes.
CREATE INDEX IF NOT EXISTS "idx_br_tested_by"
  ON "benchmark_results" ("tested_by");

CREATE INDEX IF NOT EXISTS "idx_br_evaluation_date"
  ON "benchmark_results" ("evaluation_date" DESC);

-- =====================================================================
-- 3. model_aliases: alias → entity stable_id mapping
-- =====================================================================

CREATE TABLE IF NOT EXISTS "model_aliases" (
  -- Lowercased alias as the natural primary key — the resolution lookup is
  -- "given a raw external string, find the canonical model entity". Two
  -- different sources can supply the same alias for the same model (e.g.
  -- "Claude 3.5 Sonnet" appears on HELM and on Scale MASK); recording each
  -- (alias, source) separately would duplicate the resolution data without
  -- adding signal. If the same alias maps to different models on different
  -- sources, that's a real conflict the ingester must surface — not silently
  -- last-write-wins — so a flat PK is correct.
  "alias" text PRIMARY KEY NOT NULL,
  "model_stable_id" text NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  -- Where this alias was observed: 'yaml-seed' for the initial bulk load
  -- from ai-models.yaml `aliases:` arrays, then leaderboard slugs
  -- ('helm-safety', 'mask', 'fortress', ...) once ingesters start writing.
  "source" text NOT NULL DEFAULT 'yaml-seed',
  -- 'exact' = byte-for-byte match in source data; 'fuzzy' = Levenshtein
  -- match suggested by ingester, awaiting human confirmation; 'manual' =
  -- promoted by a human via /internal/benchmark-quarantine.
  "confidence" text NOT NULL DEFAULT 'exact',
  "added_at" timestamp with time zone NOT NULL DEFAULT now(),
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "model_aliases"
  ADD CONSTRAINT "chk_model_aliases_confidence"
  CHECK ("confidence" IN ('exact', 'fuzzy', 'manual')) NOT VALID;

ALTER TABLE "model_aliases" VALIDATE CONSTRAINT "chk_model_aliases_confidence";

CREATE INDEX IF NOT EXISTS "idx_model_aliases_model"
  ON "model_aliases" ("model_stable_id");

CREATE INDEX IF NOT EXISTS "idx_model_aliases_source"
  ON "model_aliases" ("source");

-- =====================================================================
-- 4. benchmark_results_pending: quarantine queue for unresolved model names
-- =====================================================================

CREATE TABLE IF NOT EXISTS "benchmark_results_pending" (
  "id" text PRIMARY KEY NOT NULL,
  "benchmark_id" text NOT NULL REFERENCES "benchmarks"("id") ON DELETE CASCADE,
  -- The exact string the source emitted (e.g. "claude-3-5-sonnet-2024-10",
  -- "Claude 3.5 Sonnet (new)"). Preserving the literal string matters: a
  -- human reviewer matches it against ai-models.yaml entries to add an
  -- alias. Preserves case for readability — dedup happens via the alias
  -- table, not here.
  "raw_model_name" text NOT NULL,
  "score" double precision,
  "score_text" text,
  "unit" text,
  "evaluation_date" text,
  "tested_by" text NOT NULL DEFAULT 'unknown',
  "source_url" text,
  "methodology_notes" text,
  -- Whatever extra fields the source exposed that we may want to surface in
  -- the dashboard but don't yet have first-class columns for (sub-scenario
  -- breakdowns, prompt-set hashes, etc.).
  "raw_payload" jsonb,
  "status" text NOT NULL DEFAULT 'pending',
  "ingester_source" text NOT NULL,
  "resolved_to_stable_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "rejected_reason" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "benchmark_results_pending"
  ADD CONSTRAINT "chk_brp_status"
  CHECK ("status" IN ('pending', 'resolved', 'rejected')) NOT VALID;

ALTER TABLE "benchmark_results_pending" VALIDATE CONSTRAINT "chk_brp_status";

ALTER TABLE "benchmark_results_pending"
  ADD CONSTRAINT "chk_brp_tested_by"
  CHECK ("tested_by" IN (
    'self-report',
    'leaderboard',
    'aisi-uk',
    'aisi-us',
    'metr',
    'apollo',
    'third-party-paper',
    'epoch-ai',
    'unknown'
  )) NOT VALID;

ALTER TABLE "benchmark_results_pending" VALIDATE CONSTRAINT "chk_brp_tested_by";

CREATE INDEX IF NOT EXISTS "idx_brp_benchmark"
  ON "benchmark_results_pending" ("benchmark_id");

CREATE INDEX IF NOT EXISTS "idx_brp_status"
  ON "benchmark_results_pending" ("status");

CREATE INDEX IF NOT EXISTS "idx_brp_ingester_source"
  ON "benchmark_results_pending" ("ingester_source");

CREATE INDEX IF NOT EXISTS "idx_brp_created_at"
  ON "benchmark_results_pending" ("created_at" DESC);

-- Natural key: don't reinsert the same (source, raw_name, benchmark, eval
-- date) combination twice — each ingester run should be idempotent on the
-- quarantine table just like benchmark_results is. Three sources reporting
-- the same unresolved alias means three rows; one source reporting the same
-- alias twice in the same wave means one row.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_brp_natural_key"
  ON "benchmark_results_pending" (
    "ingester_source",
    "benchmark_id",
    lower("raw_model_name"),
    COALESCE("evaluation_date", '')
  );

-- QUA-702 Phase 3 follow-up: benchmark linking from system cards.
--
-- Two changes:
--   1. `benchmark_results.tested_by` — provenance column. Existing rows
--      stay NULL ("unknown / pre-tested_by"); self-reports inserted by
--      the model_system_cards post-upsert hook are tagged 'self-report'.
--      Third-party rows can be tagged 'third-party' once the benchmark
--      ingestion pipeline starts populating it. The hook never overwrites
--      a row whose tested_by is anything other than 'self-report', so
--      both NULL legacy rows and 'third-party' rows are protected.
--
--   2. `pending_benchmark_links` — queue for cited benchmarks whose name
--      could not be resolved to a benchmarks.id. Populated by the same
--      post-upsert hook. Idempotent on re-extract via the unique index
--      on (model_system_card_id, cited_name).
--
-- Schema in apps/wiki-server/src/schema.ts (modelSystemCards extends, plus
-- pendingBenchmarkLinks).

-- ── 1. benchmark_results.tested_by ──────────────────────────────────────

ALTER TABLE "benchmark_results"
  ADD COLUMN IF NOT EXISTS "tested_by" text;

-- Allowlist constraint. Added with NOT VALID + VALIDATE because the table
-- is non-trivial in size on prod, even though it's smaller than the
-- QUA-302 incident threshold.
ALTER TABLE "benchmark_results"
  ADD CONSTRAINT "chk_br_tested_by"
  CHECK ("tested_by" IS NULL OR "tested_by" IN ('self-report', 'third-party'))
  NOT VALID;

ALTER TABLE "benchmark_results" VALIDATE CONSTRAINT "chk_br_tested_by";

CREATE INDEX IF NOT EXISTS "idx_br_tested_by"
  ON "benchmark_results" ("tested_by");

-- ── 2. pending_benchmark_links ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "pending_benchmark_links" (
  "id" text PRIMARY KEY,
  "model_system_card_id" text NOT NULL,
  "ai_model_id" text NOT NULL,
  "cited_name" text NOT NULL,
  -- Generated stored column. Mirrors normalizeBenchmarkName() in
  -- apps/wiki-server/src/routes/tablebase/system-card-benchmark-linker.ts.
  -- Update both together if the normalization rules change.
  "cited_name_normalized" text GENERATED ALWAYS AS (
    regexp_replace(lower("cited_name"), '[^a-z0-9]', '', 'g')
  ) STORED,
  "cited_score" double precision,
  "cited_metric" text,
  "cited_setup" text,
  "cited_excerpt" text,
  "resolved_benchmark_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "resolution_notes" text,
  "resolved_at" timestamptz,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_pbl_card"
  ON "pending_benchmark_links" ("model_system_card_id");

CREATE INDEX IF NOT EXISTS "idx_pbl_model"
  ON "pending_benchmark_links" ("ai_model_id");

CREATE INDEX IF NOT EXISTS "idx_pbl_status"
  ON "pending_benchmark_links" ("status");

CREATE INDEX IF NOT EXISTS "idx_pbl_resolved_benchmark"
  ON "pending_benchmark_links" ("resolved_benchmark_id");

-- Idempotency on re-extract: the same card can mention the same benchmark
-- name only once, even across name variants ("SWE-bench Verified" vs
-- "swe-bench-verified"). Re-running the extractor should upsert this row,
-- not insert duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pbl_card_name"
  ON "pending_benchmark_links" ("model_system_card_id", "cited_name_normalized");

ALTER TABLE "pending_benchmark_links"
  ADD CONSTRAINT "chk_pbl_status"
  CHECK ("status" IN ('pending', 'resolved', 'rejected', 'auto-resolved'))
  NOT VALID;

ALTER TABLE "pending_benchmark_links" VALIDATE CONSTRAINT "chk_pbl_status";

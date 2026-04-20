-- QUA-632 Phase 1: enrichment_targets table.
--
-- Stores estimated denominators — per (entity_id, record_type) — so coverage
-- bursts can track progress toward a percentage goal (e.g. "70% of Anthropic
-- personnel rows").  `basis` explains how `estimated_total` was derived
-- (headcount heuristic, LinkedIn employee count, press release, etc.) so the
-- estimate stays falsifiable.
--
-- Companion to 0203_qua_632_enrichment_runs.sql and the /api/enrichment/propose
-- endpoint.

CREATE TABLE IF NOT EXISTS "enrichment_targets" (
  "id" bigserial PRIMARY KEY,
  "entity_id" text NOT NULL,
  "record_type" text NOT NULL,
  "estimated_total" integer NOT NULL,
  "target_pct" real NOT NULL DEFAULT 0.70,
  "estimated_at" timestamptz NOT NULL DEFAULT NOW(),
  "basis" text,
  "confidence" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_enrichment_targets_entity_record"
  ON "enrichment_targets" ("entity_id", "record_type");

CREATE INDEX IF NOT EXISTS "idx_enrichment_targets_record_type"
  ON "enrichment_targets" ("record_type");

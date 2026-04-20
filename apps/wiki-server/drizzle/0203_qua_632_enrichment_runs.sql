-- QUA-632 Phase 1: enrichment_runs ledger.
--
-- One row per defensive-enrichment burst.  /api/enrichment/propose updates
-- this ledger as proposes arrive, so we can see tier breakdown, cost, and
-- verdict distribution per run without joining evidence rows.
--
-- `id` is caller-supplied (e.g. a short slug like "anthropic-personnel-t1-2026-04-20")
-- so the same run can be resumed across sessions.

CREATE TABLE IF NOT EXISTS "enrichment_runs" (
  "id" text PRIMARY KEY CHECK (char_length("id") > 0 AND char_length("id") <= 128),
  "label" text,
  "record_type" text,
  "entity_id" text,
  "tier" text,
  "started_at" timestamptz NOT NULL DEFAULT NOW(),
  "finished_at" timestamptz,
  "proposes_total" integer NOT NULL DEFAULT 0,
  "proposes_accepted" integer NOT NULL DEFAULT 0,
  "proposes_rejected" integer NOT NULL DEFAULT 0,
  "accepted_t1" integer NOT NULL DEFAULT 0,
  "accepted_t2" integer NOT NULL DEFAULT 0,
  "accepted_t3" integer NOT NULL DEFAULT 0,
  "verdict_confirmed" integer NOT NULL DEFAULT 0,
  "verdict_contradicted" integer NOT NULL DEFAULT 0,
  "verdict_outdated" integer NOT NULL DEFAULT 0,
  "verdict_partial" integer NOT NULL DEFAULT 0,
  "verdict_unverifiable" integer NOT NULL DEFAULT 0,
  "cost_usd" real NOT NULL DEFAULT 0,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_enrichment_runs_record_type"
  ON "enrichment_runs" ("record_type");

CREATE INDEX IF NOT EXISTS "idx_enrichment_runs_entity"
  ON "enrichment_runs" ("entity_id");

CREATE INDEX IF NOT EXISTS "idx_enrichment_runs_started_at"
  ON "enrichment_runs" ("started_at" DESC);

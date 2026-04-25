-- QUA-693 Phase 6: ai_incidents + ai_incident_reports.
--
-- Mirror of MIT AI Incident Database (CC-BY-SA 4.0) — metadata only. Per
-- upstream license, `reports.text` field is explicitly excluded from
-- CC-BY-SA; we persist URL/title/publisher/published_at but NOT the full
-- article body. validate-aiid-no-report-text.ts enforces this.
--
-- OECD AI Incident Monitor (AIM) ingest deferred to Phase 7 pending
-- structured-export verification (see Linear QUA-693 comment).
--
-- Schema follows the plan posted in QUA-693. The `source` column is
-- CHECK-constrained to the current enumeration; future sources (e.g.
-- OECD AIM) will widen the constraint in a follow-up migration after
-- enumerating prod rows.
--
-- `ai_incident_reports` is a 1:N join (AIID averages ~12 reports/incident).
-- Composite PK `(incident_id, url)` dedupes reports naturally when the
-- same URL is cited more than once.

CREATE TABLE IF NOT EXISTS "ai_incidents" (
  "id" varchar(10) PRIMARY KEY,
  "source" varchar(16) NOT NULL,
  "source_incident_id" varchar(128) NOT NULL,
  "reported_date" date,
  "incident_date" date,
  "severity" varchar(32),
  "upstream_severity" varchar(64),
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "full_report_url" text,
  "ai_model_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "org_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "developer_org_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "attribution_confidence" numeric(3, 2),
  "tags" text[] NOT NULL DEFAULT '{}'::text[],
  "raw" jsonb NOT NULL,
  "upstream_fetched_at" timestamptz NOT NULL,
  "synced_at" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_ai_incidents_source" CHECK ("source" IN ('mit-aiid'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_ai_incidents_source_incident"
  ON "ai_incidents" ("source", "source_incident_id");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_source"
  ON "ai_incidents" ("source");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_ai_model"
  ON "ai_incidents" ("ai_model_id");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_org"
  ON "ai_incidents" ("org_id");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_developer_org"
  ON "ai_incidents" ("developer_org_id");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_reported_date"
  ON "ai_incidents" ("reported_date");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_incident_date"
  ON "ai_incidents" ("incident_date");

CREATE INDEX IF NOT EXISTS "idx_ai_incidents_tags_gin"
  ON "ai_incidents" USING GIN ("tags");


CREATE TABLE IF NOT EXISTS "ai_incident_reports" (
  "incident_id" varchar(10) NOT NULL REFERENCES "ai_incidents"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "title" text,
  "publisher" text,
  "published_at" date,
  "language" varchar(8),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("incident_id", "url")
);

CREATE INDEX IF NOT EXISTS "idx_ai_incident_reports_published_at"
  ON "ai_incident_reports" ("published_at");

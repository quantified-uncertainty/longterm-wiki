-- prediction_market_questions: tracks prediction market questions linked to wiki entities
CREATE TABLE IF NOT EXISTS "prediction_market_questions" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "platform" text NOT NULL,
  "platform_question_id" text NOT NULL,
  "entity_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "entity_display_name" text,
  "question_text" text NOT NULL,
  "question_url" text,
  "resolution_date" text,
  "resolution_criteria" text,
  "question_type" text NOT NULL DEFAULT 'binary',
  "category" text,
  "is_resolved" boolean NOT NULL DEFAULT false,
  "resolution_value" numeric,
  "resolution_notes" text,
  "current_probability" numeric,
  "discovery_method" text,
  "source" text,
  "notes" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_pmq_platform_id" ON "prediction_market_questions" ("platform", "platform_question_id");
CREATE INDEX IF NOT EXISTS "idx_pmq_entity" ON "prediction_market_questions" ("entity_id");
CREATE INDEX IF NOT EXISTS "idx_pmq_platform" ON "prediction_market_questions" ("platform");
CREATE INDEX IF NOT EXISTS "idx_pmq_resolved" ON "prediction_market_questions" ("is_resolved");
CREATE INDEX IF NOT EXISTS "idx_pmq_category" ON "prediction_market_questions" ("category");

-- prediction_market_snapshots: time-series probability observations
CREATE TABLE IF NOT EXISTS "prediction_market_snapshots" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "question_id" varchar(10) NOT NULL REFERENCES "prediction_market_questions"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "probability" numeric,
  "probability_low" numeric,
  "probability_high" numeric,
  "num_forecasters" integer,
  "volume" numeric,
  "open_interest" numeric,
  "community_prediction" numeric,
  "source" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_pms_question_date" ON "prediction_market_snapshots" ("question_id", "date");
CREATE INDEX IF NOT EXISTS "idx_pms_question" ON "prediction_market_snapshots" ("question_id");
CREATE INDEX IF NOT EXISTS "idx_pms_date" ON "prediction_market_snapshots" ("date");

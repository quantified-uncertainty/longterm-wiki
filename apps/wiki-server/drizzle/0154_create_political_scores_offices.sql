-- Political Scores: scorecard ratings from interest groups
CREATE TABLE IF NOT EXISTS "political_scores" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "politician_entity_id" text NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "politician_display_name" text,
  "scorer_org" text NOT NULL,
  "scorer_entity_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "score" numeric NOT NULL,
  "max_score" numeric NOT NULL DEFAULT 100,
  "year" integer NOT NULL,
  "score_type" text,
  "source_url" text,
  "notes" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_polscore_politician" ON "political_scores" ("politician_entity_id");
CREATE INDEX IF NOT EXISTS "idx_polscore_scorer" ON "political_scores" ("scorer_entity_id");
CREATE INDEX IF NOT EXISTS "idx_polscore_year" ON "political_scores" ("year");
CREATE INDEX IF NOT EXISTS "idx_polscore_score_type" ON "political_scores" ("score_type");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_political_scores_natural_key"
  ON "political_scores" ("politician_entity_id", "scorer_org", "year", "score_type");

-- Political Offices: current and past offices held by politicians
CREATE TABLE IF NOT EXISTS "political_offices" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "politician_entity_id" text NOT NULL REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "politician_display_name" text,
  "office_type" text NOT NULL,
  "jurisdiction" text NOT NULL,
  "district" text,
  "party" text,
  "status" text NOT NULL DEFAULT 'incumbent',
  "term_start" text,
  "term_end" text,
  "source_url" text,
  "notes" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_poloffice_politician" ON "political_offices" ("politician_entity_id");
CREATE INDEX IF NOT EXISTS "idx_poloffice_type" ON "political_offices" ("office_type");
CREATE INDEX IF NOT EXISTS "idx_poloffice_jurisdiction" ON "political_offices" ("jurisdiction");
CREATE INDEX IF NOT EXISTS "idx_poloffice_party" ON "political_offices" ("party");
CREATE INDEX IF NOT EXISTS "idx_poloffice_status" ON "political_offices" ("status");

-- Political Votes: roll call voting records for tracked legislation
CREATE TABLE IF NOT EXISTS "political_votes" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "politician_entity_id" varchar(40) REFERENCES "entities"("stable_id") ON DELETE CASCADE,
  "politician_display_name" varchar(200),
  "legislation_entity_id" varchar(100),
  "legislation_title" varchar(500),
  "vote" varchar(20) NOT NULL,
  "vote_date" date,
  "chamber" varchar(20),
  "roll_call_number" integer,
  "congress_number" integer,
  "session" integer,
  "source_url" text,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_polvote_politician" ON "political_votes" ("politician_entity_id");
CREATE INDEX IF NOT EXISTS "idx_polvote_legislation" ON "political_votes" ("legislation_entity_id");
CREATE INDEX IF NOT EXISTS "idx_polvote_date" ON "political_votes" ("vote_date");
CREATE INDEX IF NOT EXISTS "idx_polvote_chamber" ON "political_votes" ("chamber");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_political_votes_natural_key"
  ON "political_votes" ("politician_entity_id", "legislation_entity_id", "roll_call_number", "congress_number");
